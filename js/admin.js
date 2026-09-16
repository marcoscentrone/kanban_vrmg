/* ==========================================================================
   admin.js - Area administrativa do Quadro de Fluxo
   --------------------------------------------------------------------------
   Dois cadastros, ambos em tempo real (onSnapshot), como o resto do projeto:

   1. Departamentos  -> kanban_departamentos/{id}
      { nome, criadoEm, atualizadoEm }
      Alimentam o campo "Departamento" das tarefas.

   2. Acessos        -> kanban_acessos/{email}
      { email, departamentos: [nomes], criadoEm, atualizadoEm }
      Define o que cada pessoa enxerga no quadro. O e-mail e o proprio id do
      documento, o que ja impede cadastro duplicado. Lista vazia = ve tudo.

   As tarefas guardam o NOME do departamento (nao um id), entao renomear um
   departamento atualiza em lote as tarefas e os acessos que o usavam.
   ========================================================================== */

import { db, COLECAO_CARDS, COLECAO_DEPARTAMENTOS, COLECAO_ACESSOS } from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario } from "./auth.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  getDocs,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* -------------------------------------------------------------------------- */
/* Estado                                                                     */
/* -------------------------------------------------------------------------- */

let departamentos = [];   // [{id, nome}]
let acessos = [];         // [{id, email, departamentos:[nomes]}]
let cards = [];           // so para saber quantas tarefas usam cada departamento

let editandoDepartamento = null; // id
let editandoAcesso = null;       // id (= e-mail)

const refDepartamentos = collection(db, COLECAO_DEPARTAMENTOS);
const refAcessos = collection(db, COLECAO_ACESSOS);
const refCards = collection(db, COLECAO_CARDS);

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* -------------------------------------------------------------------------- */

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

function setStatus(msg, isErro = false) {
  $("statusLine").textContent = msg;
  $("statusLine").classList.toggle("error", !!isErro);
}

function setLive(ligado, texto) {
  $("liveBadge").classList.toggle("on", ligado);
  $("liveBadge").classList.toggle("off", !ligado);
  $("liveText").textContent = texto;
}

function normalizarEmail(v) {
  return (v || "").trim().toLowerCase();
}

// Aceita o formato usual de e-mail; a validacao definitiva vem do Auth depois.
function emailValido(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function tarefasUsando(nome) {
  return cards.filter((c) => c.departamento === nome).length;
}

/* -------------------------------------------------------------------------- */
/* Leitura em tempo real                                                      */
/* -------------------------------------------------------------------------- */

let conectado = false;

function escutarTudo() {
  const opcoes = { includeMetadataChanges: true };

  onSnapshot(refDepartamentos, opcoes, (snap) => {
    departamentos = snap.docs
      .map((d) => ({ id: d.id, nome: (d.data().nome || "").trim() }))
      .filter((d) => d.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    marcarConexao(snap);
    renderDepartamentos();
    renderCheckboxes();
    renderAcessos(); // as tags de acesso dependem dos nomes
  }, erroDe("departamentos"));

  onSnapshot(refAcessos, opcoes, (snap) => {
    acessos = snap.docs
      .map((d) => ({
        id: d.id,
        email: d.data().email || d.id,
        departamentos: Array.isArray(d.data().departamentos) ? d.data().departamentos : [],
        admin: d.data().admin === true
      }))
      .sort((a, b) => a.email.localeCompare(b.email, "pt-BR"));

    marcarConexao(snap);
    renderAcessos();
  }, erroDe("acessos"));

  // Somente leitura: serve para avisar quantas tarefas usam um departamento
  // antes de exclui-lo ou renomea-lo.
  onSnapshot(refCards, (snap) => {
    cards = snap.docs.map((d) => ({ id: d.id, departamento: d.data().departamento || "" }));
    renderDepartamentos();
  }, erroDe("tarefas"));
}

function marcarConexao(snap) {
  if (snap.metadata.fromCache) {
    if (!conectado) setLive(false, "sem conexão");
    return;
  }
  conectado = true;
  setLive(true, snap.metadata.hasPendingWrites ? "salvando…" : "ao vivo");
  setStatus(
    `${departamentos.length} departamento${departamentos.length === 1 ? "" : "s"} · ` +
    `${acessos.length} e-mail${acessos.length === 1 ? "" : "s"} cadastrado${acessos.length === 1 ? "" : "s"}`
  );
}

function erroDe(qual) {
  return (erro) => {
    console.error(`[admin] falha ao ler ${qual}:`, erro);
    setLive(false, "offline");
    setStatus(`Não foi possível ler ${qual} (${erro.code || erro.message}).`, true);
  };
}

/* ========================================================================== */
/* 1. CRUD de Departamentos                                                   */
/* ========================================================================== */

function renderDepartamentos() {
  const ul = $("listaDepartamentos");
  $("contaDepartamentos").textContent = departamentos.length;
  ul.innerHTML = "";

  if (!departamentos.length) {
    ul.innerHTML = '<li class="lista-vazia">Nenhum departamento cadastrado ainda.</li>';
    return;
  }

  departamentos.forEach((dep) => {
    const usos = tarefasUsando(dep.nome);
    const li = document.createElement("li");
    li.className = "item" + (editandoDepartamento === dep.id ? " editando" : "");
    li.innerHTML = `
      <div class="item-corpo">
        <div class="item-nome">${escapeHtml(dep.nome)}</div>
        <div class="item-sub">${usos} ${usos === 1 ? "tarefa usa" : "tarefas usam"} este departamento</div>
      </div>
      <div class="item-acoes">
        <button data-acao="editar" title="Renomear">✎</button>
        <button data-acao="excluir" class="excluir" title="Excluir">🗑</button>
      </div>
    `;
    li.querySelector('[data-acao="editar"]').onclick = () => renomearDepartamento(dep);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirDepartamento(dep);
    ul.appendChild(li);
  });
}

$("formDepartamento").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = $("novoDepartamento").value.trim();
  $("erroDepartamento").textContent = "";

  if (!nome) return;
  if (departamentos.some((d) => d.nome.toLowerCase() === nome.toLowerCase())) {
    $("erroDepartamento").textContent = "Já existe um departamento com esse nome.";
    return;
  }

  try {
    await addDoc(refDepartamentos, {
      nome,
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp()
    });
    $("novoDepartamento").value = "";
    setStatus(`Departamento "${nome}" criado.`);
  } catch (err) {
    console.error("[admin] falha ao criar departamento:", err);
    $("erroDepartamento").textContent = "Erro ao salvar. Verifique a conexão.";
  }
});

// Renomear propaga para as tarefas e os acessos, porque ambos guardam o NOME.
async function renomearDepartamento(dep) {
  const novo = prompt(`Renomear "${dep.nome}" para:`, dep.nome);
  if (novo === null) return;

  const nome = novo.trim();
  if (!nome || nome === dep.nome) return;

  if (departamentos.some((d) => d.id !== dep.id && d.nome.toLowerCase() === nome.toLowerCase())) {
    $("erroDepartamento").textContent = "Já existe um departamento com esse nome.";
    return;
  }

  const tarefas = cards.filter((c) => c.departamento === dep.nome);
  const vinculos = acessos.filter((a) => a.departamentos.includes(dep.nome));

  try {
    const lote = writeBatch(db);
    lote.update(doc(db, COLECAO_DEPARTAMENTOS, dep.id), {
      nome,
      atualizadoEm: serverTimestamp()
    });
    tarefas.forEach((c) =>
      lote.update(doc(db, COLECAO_CARDS, c.id), { departamento: nome })
    );
    vinculos.forEach((a) =>
      lote.update(doc(db, COLECAO_ACESSOS, a.id), {
        departamentos: a.departamentos.map((n) => (n === dep.nome ? nome : n)),
        atualizadoEm: serverTimestamp()
      })
    );
    await lote.commit();

    setStatus(
      `Renomeado para "${nome}" — ${tarefas.length} tarefa(s) e ${vinculos.length} acesso(s) atualizados.`
    );
  } catch (err) {
    console.error("[admin] falha ao renomear:", err);
    $("erroDepartamento").textContent = "Erro ao renomear.";
  }
}

async function excluirDepartamento(dep) {
  const usos = tarefasUsando(dep.nome);
  if (usos > 0) {
    $("erroDepartamento").textContent =
      `"${dep.nome}" não pode ser excluído: ${usos} tarefa(s) ainda usam. Troque o departamento delas antes.`;
    return;
  }

  const vinculos = acessos.filter((a) => a.departamentos.includes(dep.nome));
  const aviso = vinculos.length
    ? `\n\n${vinculos.length} e-mail(s) perderão este departamento.`
    : "";
  if (!confirm(`Excluir o departamento "${dep.nome}"?${aviso}`)) return;

  try {
    const lote = writeBatch(db);
    lote.delete(doc(db, COLECAO_DEPARTAMENTOS, dep.id));
    vinculos.forEach((a) =>
      lote.update(doc(db, COLECAO_ACESSOS, a.id), {
        departamentos: a.departamentos.filter((n) => n !== dep.nome),
        atualizadoEm: serverTimestamp()
      })
    );
    await lote.commit();
    $("erroDepartamento").textContent = "";
    setStatus(`Departamento "${dep.nome}" excluído.`);
  } catch (err) {
    console.error("[admin] falha ao excluir departamento:", err);
    $("erroDepartamento").textContent = "Erro ao excluir.";
  }
}

/* ========================================================================== */
/* 2. CRUD de Acessos (e-mail -> departamentos)                               */
/* ========================================================================== */

function renderCheckboxes(marcados = []) {
  const box = $("checkboxesDepartamentos");
  box.innerHTML = "";

  if (!departamentos.length) {
    box.innerHTML = '<span class="vazio">Cadastre um departamento primeiro.</span>';
    return;
  }

  departamentos.forEach((dep) => {
    const label = document.createElement("label");
    label.innerHTML =
      `<input type="checkbox" value="${escapeHtml(dep.nome)}"${marcados.includes(dep.nome) ? " checked" : ""}>` +
      `<span>${escapeHtml(dep.nome)}</span>`;
    box.appendChild(label);
  });
}

function departamentosMarcados() {
  return Array.from($("checkboxesDepartamentos").querySelectorAll("input:checked")).map(
    (i) => i.value
  );
}

function renderAcessos() {
  const ul = $("listaAcessos");
  $("contaAcessos").textContent = acessos.length;
  ul.innerHTML = "";

  if (!acessos.length) {
    ul.innerHTML = '<li class="lista-vazia">Nenhum e-mail cadastrado ainda.</li>';
    return;
  }

  acessos.forEach((ac) => {
    const li = document.createElement("li");
    li.className = "item" + (editandoAcesso === ac.id ? " editando" : "");

    const tags = ac.departamentos.length
      ? `<div class="item-tags">${ac.departamentos
          .map((n) => `<span>${escapeHtml(n)}</span>`)
          .join("")}</div>`
      : `<div class="item-sub"><span class="nenhum">sem restrição — vê todas as tarefas</span></div>`;

    li.innerHTML = `
      <div class="item-corpo">
        <div class="item-nome">${escapeHtml(ac.email)}${ac.admin ? ' <span class="tag-admin">admin</span>' : ""}</div>
        ${tags}
      </div>
      <div class="item-acoes">
        <button data-acao="editar" title="Editar departamentos">✎</button>
        <button data-acao="excluir" class="excluir" title="Remover acesso">🗑</button>
      </div>
    `;
    li.querySelector('[data-acao="editar"]').onclick = () => editarAcesso(ac);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirAcesso(ac);
    ul.appendChild(li);
  });
}

function editarAcesso(ac) {
  editandoAcesso = ac.id;
  $("novoEmail").value = ac.email;
  $("novoEmail").disabled = true; // o e-mail e a chave do documento
  $("ehAdmin").checked = !!ac.admin;
  renderCheckboxes(ac.departamentos);
  $("salvarAcesso").textContent = "Salvar alterações";
  $("cancelarAcesso").style.display = "inline-block";
  $("erroAcesso").textContent = "";
  renderAcessos();
  $("checkboxesDepartamentos").scrollIntoView({ behavior: "smooth", block: "center" });
}

function limparFormAcesso() {
  editandoAcesso = null;
  $("novoEmail").value = "";
  $("novoEmail").disabled = false;
  $("ehAdmin").checked = false;
  renderCheckboxes();
  $("salvarAcesso").textContent = "Adicionar acesso";
  $("cancelarAcesso").style.display = "none";
  $("erroAcesso").textContent = "";
  renderAcessos();
}

$("cancelarAcesso").addEventListener("click", limparFormAcesso);

$("formAcesso").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("erroAcesso").textContent = "";

  const email = normalizarEmail($("novoEmail").value);
  if (!emailValido(email)) {
    $("erroAcesso").textContent = "Informe um e-mail válido.";
    return;
  }

  if (!editandoAcesso && acessos.some((a) => a.id === email)) {
    $("erroAcesso").textContent = "Este e-mail já está cadastrado. Use o ✎ para editar.";
    return;
  }

  const marcados = departamentosMarcados();
  const btn = $("salvarAcesso");
  btn.disabled = true;

  try {
    // setDoc com o e-mail como id: cria ou substitui, sem risco de duplicar.
    await setDoc(
      doc(db, COLECAO_ACESSOS, email),
      {
        email,
        departamentos: marcados,
        admin: $("ehAdmin").checked,
        atualizadoEm: serverTimestamp(),
        ...(editandoAcesso ? {} : { criadoEm: serverTimestamp() })
      },
      { merge: true }
    );
    setStatus(
      marcados.length
        ? `${email} → ${marcados.join(", ")}`
        : `${email} → sem restrição (vê todas as tarefas)`
    );
    limparFormAcesso();
  } catch (err) {
    console.error("[admin] falha ao salvar acesso:", err);
    $("erroAcesso").textContent = "Erro ao salvar. Verifique a conexão.";
  } finally {
    btn.disabled = false;
  }
});

async function excluirAcesso(ac) {
  if (!confirm(`Remover o acesso de ${ac.email}?`)) return;
  try {
    await deleteDoc(doc(db, COLECAO_ACESSOS, ac.id));
    if (editandoAcesso === ac.id) limparFormAcesso();
    setStatus(`Acesso de ${ac.email} removido.`);
  } catch (err) {
    console.error("[admin] falha ao excluir acesso:", err);
    $("erroAcesso").textContent = "Erro ao remover.";
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

// Existe pelo menos um administrador cadastrado?
async function existeAlgumAdmin() {
  try {
    const snap = await getDocs(query(refAcessos, where("admin", "==", true), limit(1)));
    return !snap.empty;
  } catch (e) {
    console.error("[admin] falha ao verificar administradores:", e);
    return true; // na duvida, nao abre a porta
  }
}

// Esta pagina exige permissao de administrador (campo `admin` em kanban_acessos).
// Excecao de primeiro acesso: se NENHUM administrador existir ainda, o primeiro
// usuario autenticado consegue entrar e se cadastrar - senao o cadastro nasceria
// trancado, sem ninguem capaz de abrir.
protegerPagina({ exigirAdmin: false }).then(async (logado) => {
  const podeEntrar = logado.permissao.admin || !(await existeAlgumAdmin());

  if (!podeEntrar) {
    document.body.innerHTML =
      '<div class="sem-permissao">' +
      '<h1>Acesso restrito</h1>' +
      `<p><strong>${logado.email}</strong> não tem permissão de administrador.</p>` +
      '<p>Peça a quem administra o quadro para marcar seu e-mail como administrador.</p>' +
      '<p><a class="btn-ghost" href="index.html">← Voltar ao quadro</a></p>' +
      "</div>";
    return;
  }

  montarBarraUsuario($("barraUsuario"), logado);
  renderCheckboxes();
  escutarTudo();
});
