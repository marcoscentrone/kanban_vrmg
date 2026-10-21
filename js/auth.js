/* ==========================================================================
   auth.js - Login com Google e permissoes por departamento
   --------------------------------------------------------------------------
   Um so ponto de entrada para as duas paginas (index.html e admin.html):

     protegerPagina({ exigirAdmin })  ->  Promise<{ user, email, permissao }>

   Enquanto ninguem esta logado, mostra a tela de login e a Promise nao resolve.
   Depois do login, resolve com o usuario e com o que ele pode ver, lido de
   kanban_acessos/{email}:

     { departamentos: [...], veTudo: bool, admin: bool }

   Duas travas de acesso, iguais as do portal da empresa (ver firebase-config):
     1. dominio  - so entram e-mails do dominio corporativo
     2. cadastro - so entra quem esta em kanban_acessos

   Regra de visibilidade (a mesma do admin.html):
     - lista de departamentos vazia  -> ve TUDO
     - lista preenchida              -> ve so aqueles departamentos
   ========================================================================== */

import {
  auth, db, COLECAO_ACESSOS,
  DOMINIOS_PERMITIDOS, EMAILS_LIBERADOS, EXIGIR_CADASTRO, EMAIL_DONO, SIMULAR_USUARIO
} from "./firebase-config.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const provider = new GoogleAuthProvider();
// Sempre perguntar qual conta usar - evita entrar com a conta pessoal sem querer.
provider.setCustomParameters({ prompt: "select_account" });

// Dica ao Google de qual dominio oferecer primeiro na tela de contas.
if (DOMINIOS_PERMITIDOS.length === 1) {
  provider.setCustomParameters({ prompt: "select_account", hd: DOMINIOS_PERMITIDOS[0] });
}

/* -------------------------------------------------------------------------- */
/* Trava 1: dominio                                                           */
/* -------------------------------------------------------------------------- */

// Lista de dominios vazia = qualquer conta Google entra (modo teste).
export function dominioPermitido(email) {
  if (!email) return false;
  if (email === EMAIL_DONO.toLowerCase()) return true;
  if (EMAILS_LIBERADOS.map((e) => e.toLowerCase()).includes(email)) return true;
  if (!DOMINIOS_PERMITIDOS.length) return true;
  return DOMINIOS_PERMITIDOS.some((d) => email.endsWith("@" + d.toLowerCase()));
}

function textoDominios() {
  return DOMINIOS_PERMITIDOS.map((d) => "@" + d).join(" ou ");
}

/* -------------------------------------------------------------------------- */
/* Tela de login                                                              */
/* -------------------------------------------------------------------------- */

function montarTelaLogin() {
  const tela = document.createElement("div");
  tela.className = "login-tela";
  tela.id = "loginTela";
  tela.innerHTML = `
    <div class="login-caixa">
      <h1>Quadro de <span>Fluxo</span></h1>
      <p class="login-sub">VR Software — Unidade Minas Gerais</p>

      <button class="login-google" id="btnGoogle">
        <span class="g">G</span>
        <span>Entrar com Google</span>
      </button>

      <p class="login-hint">${
        DOMINIOS_PERMITIDOS.length
          ? "Use seu e-mail " + textoDominios() + "."
          : "Use seu e-mail corporativo."
      }</p>
      <p class="login-erro" id="loginErro"></p>
    </div>
  `;
  document.body.appendChild(tela);

  tela.querySelector("#btnGoogle").onclick = entrar;
  return tela;
}

function mostrarErro(msg) {
  const el = document.getElementById("loginErro");
  if (el) el.textContent = msg;
}

async function entrar() {
  mostrarErro("");
  const btn = document.getElementById("btnGoogle");
  if (btn) btn.disabled = true;

  try {
    const cred = await signInWithPopup(auth, provider);
    const email = (cred.user.email || "").toLowerCase();

    if (!dominioPermitido(email)) {
      await signOut(auth);
      mostrarErro(`Acesso restrito a e-mails ${textoDominios()}. A conta ${email} não pertence à empresa.`);
    }
  } catch (e) {
    console.error("[auth] falha no login:", e);
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
      mostrarErro("");
    } else if (e.code === "auth/unauthorized-domain") {
      mostrarErro("Domínio não autorizado no Firebase (Authentication → Settings → Authorized domains).");
    } else if (e.code === "auth/operation-not-allowed") {
      mostrarErro("Login com Google não está ativado no Firebase Console.");
    } else if (e.code === "auth/popup-blocked") {
      mostrarErro("O navegador bloqueou a janela de login. Libere os pop-ups para este site.");
    } else {
      mostrarErro("Não foi possível entrar. Tente novamente.");
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function sair() {
  return signOut(auth);
}

/* -------------------------------------------------------------------------- */
/* Permissoes                                                                 */
/* -------------------------------------------------------------------------- */

// Le kanban_acessos/{email}. Quem nao tem cadastro so chega ate aqui se
// EXIGIR_CADASTRO estiver desligado - e nesse caso ve tudo.
export async function carregarPermissao(email) {
  const semCadastro = {
    departamentos: [], veTudo: true, admin: false, supervisor: false, cadastrado: false
  };
  if (!email) return semCadastro;

  // O dono passa direto: acesso total sem depender de leitura do banco. Assim
  // ele consegue configurar tudo mesmo com kanban_acessos ainda vazia.
  if (email === EMAIL_DONO.toLowerCase()) {
    return { departamentos: [], veTudo: true, admin: true, supervisor: false, cadastrado: true, dono: true };
  }

  try {
    const snap = await getDoc(doc(db, COLECAO_ACESSOS, email));
    if (!snap.exists()) return semCadastro;

    const dados = snap.data();
    const deps = Array.isArray(dados.departamentos) ? dados.departamentos.filter(Boolean) : [];
    const admin = dados.admin === true;
    const supervisor = dados.supervisor === true;
    return {
      departamentos: deps,
      // Administrador enxerga o quadro inteiro, mesmo com departamentos
      // marcados no cadastro: quem administra precisa da visao completa.
      // Supervisor NAO ve tudo - fica restrito aos departamentos dele (so que
      // com poder total dentro deles).
      veTudo: admin || deps.length === 0,
      admin,
      supervisor,
      cadastrado: true
    };
  } catch (e) {
    console.error("[auth] falha ao ler permissões:", e);
    return semCadastro;
  }
}

// Trava 2: com EXIGIR_CADASTRO ligado, so entra quem tem documento em
// kanban_acessos. A excecao e o primeiro acesso - se ainda nao existe nenhum
// administrador, alguem precisa conseguir entrar para criar o primeiro.
async function cadastroObrigatorioOk(permissao) {
  if (!EXIGIR_CADASTRO || permissao.cadastrado) return true;
  return (await existeAlgumAdmin()) === false; // "erro" mantem a porta fechada
}

// Retorna true/false, ou a string "erro" quando nem deu para consultar - o que
// quase sempre significa que as regras do Firestore ainda nao liberam
// kanban_acessos. Quem chama precisa saber a diferenca entre "nao ha admin" e
// "nao consegui verificar".
export async function existeAlgumAdmin() {
  try {
    const snap = await getDocs(query(collection(db, COLECAO_ACESSOS), where("admin", "==", true), limit(1)));
    return !snap.empty;
  } catch (e) {
    console.error("[auth] falha ao verificar administradores:", e);
    return "erro";
  }
}

/* -------------------------------------------------------------------------- */
/* Porta de entrada das paginas                                               */
/* -------------------------------------------------------------------------- */

export function protegerPagina({ exigirAdmin = false } = {}) {
  return new Promise((resolve) => {
    let tela = null;

    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        document.body.classList.add("nao-logado");
        if (!tela) tela = montarTelaLogin();
        return;
      }

      const email = (user.email || "").toLowerCase();

      // Trava 1 - dominio
      if (!dominioPermitido(email)) {
        await signOut(auth);
        if (!tela) tela = montarTelaLogin();
        document.body.classList.add("nao-logado");
        mostrarErro(`Acesso restrito a e-mails ${textoDominios()}. A conta ${email} não pertence à empresa.`);
        return;
      }

      const permissao = await carregarPermissao(email);

      // Trava 2 - cadastro obrigatorio
      if (!(await cadastroObrigatorioOk(permissao))) {
        await signOut(auth);
        if (!tela) tela = montarTelaLogin();
        document.body.classList.add("nao-logado");
        mostrarErro(
          `${email} ainda não tem acesso liberado. ` +
          "Peça a quem administra o quadro para cadastrar seu e-mail."
        );
        return;
      }

      if (exigirAdmin && !permissao.admin) {
        if (!tela) tela = montarTelaLogin();
        document.body.classList.add("nao-logado");
        mostrarErro(
          `${email} não tem permissão de administrador. ` +
          `Peça a quem administra o quadro para marcar seu e-mail como administrador.`
        );
        return;
      }

      if (tela) { tela.remove(); tela = null; }
      document.body.classList.remove("nao-logado");

      // DEV: troca email/permissao SO na interface (ver SIMULAR_USUARIO).
      let emailFinal = email, permissaoFinal = permissao;
      if (SIMULAR_USUARIO) {
        emailFinal = (SIMULAR_USUARIO.email || email).toLowerCase();
        const deps = SIMULAR_USUARIO.departamentos || [];
        permissaoFinal = {
          departamentos: deps,
          veTudo: !!SIMULAR_USUARIO.admin || deps.length === 0,
          admin: !!SIMULAR_USUARIO.admin,
          supervisor: !!SIMULAR_USUARIO.supervisor,
          cadastrado: true,
          simulado: true
        };
        console.warn("[auth] SIMULANDO usuario:", emailFinal, permissaoFinal,
          "— só afeta a INTERFACE; o servidor usa seu token real.");
      }

      resolve({ user, email: emailFinal, permissao: permissaoFinal });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Barra do usuario logado (canto superior)                                   */
/* -------------------------------------------------------------------------- */

// Escapa < > & " ' para uso seguro em texto E em atributos. Mesma funcao das
// outras telas; auth.js nao tinha uma porque so inseria dado "confiavel" - mas
// email e photoURL vem de fora (token/Google) e nao devem ir crus para o HTML.
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A aba "Configuracao" (admin.html) so faz sentido para administrador. Quem nao
// e admin fica apenas com Relatorio e Auditoria no submenu - some o link dele.
// Chamar nas paginas que tem o submenu (admin/relatorio/auditoria) apos o login.
export function ajustarSubmenu(permissao) {
  // Admin e supervisor podem abrir a Configuracao; os demais so veem Relatorio
  // e Auditoria no submenu.
  const podeConfig = !!(permissao && (permissao.admin || permissao.supervisor));
  const link = document.getElementById("linkConfig");
  if (link && !podeConfig) link.style.display = "none";
}

export function montarBarraUsuario(container, { user, email, permissao }) {
  const box = document.createElement("div");
  box.className = "user-box";

  const foto = user.photoURL
    ? `<img class="user-foto" src="${escapeHtml(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="user-foto vazia">${escapeHtml((email[0] || "?").toUpperCase())}</span>`;

  const alcance = permissao.admin
    ? "administrador — acesso total"
    : permissao.supervisor
      ? `supervisor — ${escapeHtml(permissao.departamentos.join(", ")) || "sem departamento"}`
      : permissao.veTudo
        ? "vê todos os departamentos"
        : `vê: ${escapeHtml(permissao.departamentos.join(", "))}`;

  box.innerHTML = `
    ${foto}
    <div class="user-info">
      <span class="user-email" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
      <span class="user-alcance">${alcance}</span>
    </div>
    <button class="user-sair" title="Sair">Sair</button>
  `;
  box.querySelector(".user-sair").onclick = () => sair();
  container.appendChild(box);
  return box;
}
