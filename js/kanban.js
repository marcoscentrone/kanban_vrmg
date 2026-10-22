/* ==========================================================================
   kanban.js - Quadro de Fluxo (VR Software Minas)
   --------------------------------------------------------------------------
   Toda a logica do quadro: render das colunas/cards, drag & drop e CRUD
   no Cloud Firestore.

   Substitui por completo o antigo window.storage do prototipo:
     window.storage.get  ->  onSnapshot (tempo real, igual Inventario/Chamados)
     window.storage.set  ->  addDoc / updateDoc / deleteDoc

   As credenciais ficam em firebase-config.js (unico arquivo a trocar na
   migracao para o Firebase da empresa).
   ========================================================================== */

import {
  db, COLECAO_CARDS, COLECAO_DEPARTAMENTOS, COLECAO_ACESSOS, AMBIENTE, ADMIN_ABERTO,
  COLECAO_FINALIZADOS, COLECAO_CANCELADOS
} from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario } from "./auth.js";
import { COLUNAS_PADRAO, lerColunas, colunasDe } from "./colunas.js";
import {
  registrarCriacao, registrarExclusao, registrarEdicao,
  registrarEstadoSubtarefa, registrarMovimento,
  registrarFinalizacao, registrarCancelamento
} from "./auditoria.js";
import {
  MAX_SUBTAREFAS, ESTADO_INFO, proximoEstado, lerSubtarefas, lerPadroes,
  gerarIdSubtarefa, subtarefasIniciais, progresso
} from "./subtarefas.js";
import {
  MS_POR_DIA, hojeISO, formatarDataISO,
  progressoPrazo as progressoPrazoBase, corDoPrazo, OPACIDADE_SUBTAREFA,
  janelasDasSubtarefas, tituloSubtarefa,
  coresDasSubtarefas as coresDasSubtarefasBase
} from "./cronograma.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* --------------------------------------------------------------------------
   1. Configuracao do quadro
   -------------------------------------------------------------------------- */

// As colunas vem do departamento selecionado (cadastradas em admin.html).
// Enquanto nada estiver escolhido, o quadro usa o fluxo padrao.
let COLUNAS = COLUNAS_PADRAO.map((c) => ({ ...c, titulo: c.nome }));

// Departamentos completos ({id, nome, colunas}), para montar o fluxo.
let DEPARTAMENTOS_FULL = [];

let DEPARTAMENTOS = [];   // so os nomes, para os selects

const PRIORIDADES = ["baixa", "media", "alta"];

// A ultima lista do fluxo e a de conclusao. Uma tarefa que entra nela ganha o
// botao "Finalizar" (arquiva em cards_finalizados e sai do quadro). Nada some
// sozinho por tempo.
function colunaFinal() {
  return COLUNAS.length ? COLUNAS[COLUNAS.length - 1].id : "finalizado";
}

/* --------------------------------------------------------------------------
   2. Estado local (espelho do Firestore, alimentado pelo onSnapshot)
   -------------------------------------------------------------------------- */

let cards = [];                                  // [{id, titulo, coluna, ...}]
let editando = { colunaId: null, cardId: null }; // alvo do modal
let arrastando = null;                           // id do card em drag
let filtroDepartamento = "";   // departamento de trabalho (sempre um)
let filtroResponsavel = "";    // e-mail do responsavel filtrado ("" = todos)
let unsubCards = null;          // cancela a assinatura dos cards do depto atual
let departamentoAssinado = null;
let usuario = null;   // { user, email, permissao } - preenchido no boot

// Identificacao usada nos registros de auditoria.
function quemSouEu() {
  return usuario ? { email: usuario.email, nome: nomeDoEmail(usuario.email) } : null;
}

// Traduz o id de uma lista para o nome que aparece na tela.
function nomeDaLista(colunaId) {
  const col = COLUNAS.find((c) => c.id === colunaId);
  return col ? col.nome : colunaId;
}
let PESSOAS = [];     // nomes sugeridos no campo "Responsavel"

const cardsRef = collection(db, COLECAO_CARDS);

/* --------------------------------------------------------------------------
   3. Atalhos de DOM
   -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const groupsEl   = $("groups");
const statusEl   = $("statusLine");
const liveBadge  = $("liveBadge");
const liveText   = $("liveText");
const overlay    = $("overlay");

const filtroSel  = $("filtroDepartamento");
const filtroRespSel = $("filtroResponsavel");
const erroModal  = $("modalError");

/* --------------------------------------------------------------------------
   4. Utilidades
   -------------------------------------------------------------------------- */

function setStatus(msg, isErro = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isErro);
}

function setLive(ligado, texto) {
  liveBadge.classList.toggle("on", ligado);
  liveBadge.classList.toggle("off", !ligado);
  liveText.textContent = texto;
}

function escapeHtml(str) {
  // Escapa tambem " e ' de proposito. O truque textContent->innerHTML escapa
  // so < > & - o suficiente para TEXTO, mas NAO para dentro de um atributo
  // (title="...", value="...", data-x="..."). Como varios desses atributos
  // recebem dado do usuario, uma aspa nao escapada quebra o atributo e injeta
  // um manipulador de evento (XSS armazenado). Escapar as aspas fecha isso.
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function iniciais(nome) {
  if (!nome || !nome.trim()) return "?";
  const partes = nome.trim().split(/\s+/);
  return (partes[0][0] + (partes[1] ? partes[1][0] : "")).toUpperCase();
}

// criadoEm chega como Timestamp do Firestore; durante a escrita otimista
// (antes do servidor confirmar) usamos a estimativa local - ver data({serverTimestamps}).
function formatarData(ts) {
  if (!ts || typeof ts.toDate !== "function") return "";
  const d = ts.toDate();
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

// O dono e um e-mail. Tarefas criadas antes do login guardaram texto livre
// ("anonimo", um nome digitado) - isso nao identifica ninguem, entao vale como
// "sem dono".
function temDonoReal(card) {
  return !!card && typeof card.criadoPor === "string" && card.criadoPor.includes("@");
}

// Quem pode ALTERAR uma tarefa (editar campos, mover de lista, mudar o estado
// de uma etapa e excluir). Mesma regra para todas essas acoes:
//   . o dono (quem criou)
//   . o responsavel (quem executa)
//   . qualquer administrador
//   . qualquer pessoa, quando a tarefa nao tem dono registrado - senao as
//     criadas antes do login ficariam impossiveis de mexer
function podeAlterar(card) {
  if (!card || !usuario) return false;
  if (usuario.permissao.admin) return true;
  if (ehSupervisorDoDepto(card.departamento)) return true;
  if (!temDonoReal(card)) return true;
  if (card.criadoPor === usuario.email) return true;
  return ehOResponsavel(card);
}

// Supervisor do departamento da tarefa: pode mexer em qualquer tarefa dele,
// mesmo sem ser dono nem responsavel. Espelha a regra do Firestore.
function ehSupervisorDoDepto(dep) {
  if (!usuario || !usuario.permissao.supervisor) return false;
  const deps = usuario.permissao.departamentos || [];
  return !!dep && deps.includes(dep);
}

// Usuario comum pode "pegar para si" uma tarefa SEM responsavel do departamento
// dele. Admin/supervisor atribuem direto pelo campo, entao nao precisam disso.
function podePegar(card) {
  if (!soVeProprias() || !card || card.responsavelEmail) return false;
  return (usuario.permissao.departamentos || []).includes(card.departamento || "");
}

// E-mail do responsavel, a partir do nome escolhido (so cadastrados tem e-mail).
// Gravado no card alem do nome, para o Firestore conseguir checar permissao -
// no servidor so existe o e-mail do token, nunca o "nome".
function emailDoResponsavel(nome) {
  const n = (nome || "").trim().toLowerCase();
  if (!n) return "";
  const pessoa = PESSOAS.find((x) => x.nome.toLowerCase() === n && x.email.includes("@"));
  return pessoa ? pessoa.email.toLowerCase() : "";
}

// Comparacao por e-mail quando o card tem responsavelEmail (exato); cai para o
// nome so em cards antigos, criados antes deste campo existir.
function ehOResponsavel(card) {
  if (!usuario) return false;
  if (card.responsavelEmail) return card.responsavelEmail === usuario.email;
  const resp = (card.responsavel || "").trim().toLowerCase();
  return !!resp && resp === nomeDoEmail(usuario.email).toLowerCase();
}

function cardPorId(id) {
  return cards.find((c) => c.id === id) || null;
}

/* ---- Retencao das tarefas finalizadas ---------------------------------- */

// Momento em que a tarefa entrou em "Finalizado". Cards antigos, criados antes
// deste campo existir, caem no atualizadoEm - que para uma tarefa concluida e,
// na pratica, quando ela foi movida para la.
function finalizadaEm(card) {
  const ts = card.finalizadoEm || card.atualizadoEm;
  return ts && typeof ts.toDate === "function" ? ts.toDate() : null;
}


// Cards de uma coluna, sempre na mesma ordem: os mais perto de vencer no topo,
// os folgados abaixo, e os SEM data de termino sempre por ultimo. Nao existe
// ordem manual - a posicao e consequencia do prazo, e se reorganiza sozinha
// quando alguem edita uma data ou o dia vira.
// A coluna (id) existe no fluxo do departamento atual?
function colunaConhecida(id) {
  return COLUNAS.some((c) => c.id === id);
}

function cardsDaColuna(colunaId) {
  const col = { id: colunaId };
  // A primeira coluna tambem recolhe os orfaos: cards cuja coluna salva nao
  // existe mais neste fluxo (ex.: a lista foi apagada ou o departamento trocou
  // de fluxo). Assim nenhum card some do quadro, e o dado no servidor fica
  // intacto - e so posicionamento visual ate alguem mover o card.
  const ehPrimeira = COLUNAS.length > 0 && COLUNAS[0].id === colunaId;
  return cards
    .filter((c) =>
      c.coluna === colunaId || (ehPrimeira && !colunaConhecida(c.coluna))
    )
    .sort((a, b) => {
      const pa = progressoPrazo(a, col);
      const pb = progressoPrazo(b, col);

      // Sem data de termino: vai para o fim da coluna, mais antigas primeiro.
      if (pa === null && pb === null) return porCriacao(a, b);
      if (pa === null) return 1;
      if (pb === null) return -1;

      if (pb !== pa) return pb - pa;                  // maior urgencia no topo
      if (a.fimPrevisto !== b.fimPrevisto) {          // empate: data mais proxima
        return a.fimPrevisto < b.fimPrevisto ? -1 : 1;
      }
      return porCriacao(a, b);
    });
}

// criadoEm pode ser null no instante entre criar o card e o servidor confirmar;
// nesse caso o card fica no fim, onde acabou de nascer.
function porCriacao(a, b) {
  const ta = a.criadoEm?.toMillis?.() ?? Infinity;
  const tb = b.criadoEm?.toMillis?.() ?? Infinity;
  return ta - tb;
}

// Usuario comum (nem admin, nem supervisor, nem "ve tudo"): so enxerga as
// tarefas em que ele e o responsavel - nunca as de outras pessoas do grupo.
function soVeProprias() {
  return !!(usuario && !usuario.permissao.admin
    && !usuario.permissao.supervisor && !usuario.permissao.veTudo);
}

function cardsVisiveis(colunaId) {
  // O quadro trabalha sempre dentro de um departamento, entao o recorte por
  // departamento ja esta garantido pela lista do seletor. O filtro de
  // responsavel afina ainda mais (para o usuario comum ele fica travado nele).
  return cardsDaColuna(colunaId).filter((c) => {
    if ((c.departamento || "") !== filtroDepartamento) return false;
    // Ao filtrar por um responsavel, as tarefas SEM responsavel continuam
    // aparecendo - elas sao o "pool" visivel a todos do departamento.
    if (filtroResponsavel) {
      const resp = c.responsavelEmail || "";
      if (resp !== filtroResponsavel && resp !== "") return false;
    }
    return true;
  });
}

// "marcos.centrone@vrbelohorizonte.com.br" -> "Marcos Centrone"
function nomeDoEmail(email) {
  return (email || "")
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ");
}


/* --------------------------------------------------------------------------
   5. Leitura em tempo real (onSnapshot)
   -------------------------------------------------------------------------- */

let t0Conexao = 0;
let primeiroSnapshotServidor = false;

function escutarQuadro() {
  // (Re)assina os cards SO do departamento atual. A regra do Firestore so
  // libera a leitura quando a query pede um departamento permitido - entao
  // nao da mais para assinar a colecao inteira. Trocar de departamento
  // cancela a assinatura anterior e abre outra.
  if (unsubCards) { unsubCards(); unsubCards = null; }
  departamentoAssinado = filtroDepartamento;
  primeiroSnapshotServidor = false;

  if (!filtroDepartamento) {
    cards = [];
    render();
    return;
  }

  setStatus("Carregando quadro…");
  setLive(false, "conectando…");
  t0Conexao = performance.now();

  // Rede corporativa costuma levar alguns segundos para abrir o canal de tempo
  // real. So depois de 20s sem nenhuma resposta do servidor o aviso aparece.
  setTimeout(() => {
    if (!primeiroSnapshotServidor) {
      setLive(false, "sem conexão");
      setStatus(
        "Sem resposta do servidor. Confira se o Firestore está criado no projeto " +
          "e se as regras permitem leitura (F12 → Console mostra o erro exato).",
        true
      );
    }
  }, 20000);

  // Sem orderBy no servidor de proposito: a ordenacao e feita no cliente por
  // urgencia (prazo de termino). Assim nao e preciso indice composto no Firestore.
  //
  // Usuario comum so pode LER as proprias tarefas (regra do Firestore): a
  // consulta ja pede responsavelEmail == o e-mail dele. Admin/supervisor leem o
  // departamento inteiro, e o filtro de responsavel deles e aplicado no cliente.
  const consulta = soVeProprias()
    ? query(cardsRef,
        where("departamento", "==", filtroDepartamento),
        where("responsavelEmail", "in", [usuario.email, ""]))
    : query(cardsRef, where("departamento", "==", filtroDepartamento));

  unsubCards = onSnapshot(
    consulta,
    // includeMetadataChanges: sem isto, quando os dados do servidor sao iguais
    // aos do cache o callback nao dispara de novo - e o indicador ficaria preso
    // em "sem conexao" mesmo com o quadro ja sincronizado.
    { includeMetadataChanges: true },
    (snap) => {
      cards = snap.docs.map((d) => {
        // serverTimestamps:"estimate" evita criadoEm nulo no instante em que o
        // card acabou de ser criado e o servidor ainda nao confirmou.
        const dados = d.data({ serverTimestamps: "estimate" });
        return {
          id: d.id,
          titulo: dados.titulo || "",
          descricao: dados.descricao || "",
          coluna: dados.coluna || "",   // preserva o valor do servidor; orfaos sao tratados so na exibicao
          departamento: dados.departamento || "",
          responsavel: dados.responsavel || "",
          responsavelEmail: (dados.responsavelEmail || "").toLowerCase(),
          prioridade: PRIORIDADES.includes(dados.prioridade) ? dados.prioridade : "media",
          inicioPrevisto: typeof dados.inicioPrevisto === "string" ? dados.inicioPrevisto : "",
          fimPrevisto: typeof dados.fimPrevisto === "string" ? dados.fimPrevisto : "",
          finalizadoEm: dados.finalizadoEm || null,
          criadoPor: (dados.criadoPor || "").toLowerCase(),
          subtarefas: lerSubtarefas(dados),
          criadoEm: dados.criadoEm || null,
          atualizadoEm: dados.atualizadoEm || null
        };
      });

      // fromCache = o snapshot veio do cache local, NAO do servidor. Acontece
      // no primeiro instante e sempre que a conexao cai. Sem distinguir isso o
      // quadro diria "ao vivo" mesmo estando desconectado.
      const doCache = snap.metadata.fromCache;
      const pendente = snap.metadata.hasPendingWrites;

      if (doCache) {
        setLive(false, "sem conexão");
      } else {
        if (!primeiroSnapshotServidor) {
          primeiroSnapshotServidor = true;
          console.info(
            `[kanban] conectado ao Firestore em ${Math.round(performance.now() - t0Conexao)}ms`
          );
        }
        setLive(true, pendente ? "salvando…" : "ao vivo");
      }

      const total = cards.length;
      const sufixo = AMBIENTE === "teste" ? " · ambiente de teste (projeto kanbanvr)" : "";
      setStatus(
        doCache
          ? `${total} ${total === 1 ? "tarefa" : "tarefas"} — dados locais, sincronizando com o servidor…`
          : `${total} ${total === 1 ? "tarefa" : "tarefas"} no quadro — atualização automática ativa${sufixo}`,
        doCache
      );

      montarSugestoes();
      preencherSelectResponsavel();
      render();
    },
    (erro) => {
      console.error("[kanban] onSnapshot falhou:", erro);
      setLive(false, "offline");
      setStatus(
        `Não foi possível ler o quadro (${erro.code || erro.message}). ` +
          "Verifique as regras do Firestore e a conexão.",
        true
      );
    }
  );
}

// Sugestoes do campo "Responsavel": os e-mails cadastrados na area
// administrativa, convertidos em nome. Quem ainda nao foi cadastrado mas ja
// aparece como responsavel de alguma tarefa entra junto, para nao sumir da lista.
function escutarPessoas() {
  onSnapshot(
    collection(db, COLECAO_ACESSOS),
    (snap) => {
      PESSOAS = snap.docs
        .map((d) => {
          const dd = d.data();
          const email = (dd.email || d.id || "").toLowerCase();
          return {
            nome: nomeDoEmail(email),
            email,
            departamentos: Array.isArray(dd.departamentos) ? dd.departamentos : []
          };
        })
        .filter((p) => p.email.includes("@"));
      montarSugestoes();
      preencherSelectResponsavel();
    },
    (erro) => {
      // Sem permissao de leitura o campo simplesmente fica sem sugestoes.
      console.warn("[kanban] sem sugestões de responsável:", erro.code || erro);
      montarSugestoes();
      preencherSelectResponsavel();
    }
  );
}

// So quem esta cadastrado em kanban_acessos pode ser responsavel. A excecao e o
// nome que ja estava gravado na tarefa aberta: mantemos na lista para nao
// impedir a edicao dos outros campos de uma tarefa antiga.
function montarSugestoes(nomeAtual = "") {
  const lista = $("listaPessoas");
  if (!lista) return;

  // So sugere as pessoas que fazem parte do departamento escolhido no modal -
  // nao a lista inteira. Sem departamento definido, cai para todos (fallback).
  const dep = $("fDepartamento") ? $("fDepartamento").value : "";
  const fonte = dep
    ? PESSOAS.filter((p) => (p.departamentos || []).includes(dep))
    : PESSOAS;

  const vistos = new Map();
  fonte.forEach((p) => vistos.set(p.nome.toLowerCase(), p));

  const atual = (nomeAtual || "").trim();
  if (atual && !vistos.has(atual.toLowerCase())) {
    vistos.set(atual.toLowerCase(), { nome: atual, email: "(não cadastrado)" });
  }

  lista.innerHTML = Array.from(vistos.values())
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
    .map((p) => `<option value="${escapeHtml(p.nome)}">${escapeHtml(p.email)}</option>`)
    .join("");
}

// Nome aceito? Vazio conta como "sem responsavel". Se a lista de cadastrados
// nao carregou (falha de leitura), nao bloqueamos - seria travar o quadro por
// um problema de permissao.
function responsavelValido(nome, nomeOriginal = "") {
  const v = (nome || "").trim().toLowerCase();
  if (!v) return true;
  if (!PESSOAS.length) return true;
  if (v === (nomeOriginal || "").trim().toLowerCase()) return true;
  return PESSOAS.some((p) => p.nome.toLowerCase() === v);
}

// Re-assina os cards so quando o departamento de trabalho muda (evita
// reabrir a assinatura a cada snapshot de departamento).
function reassinarCardsSeMudou() {
  if (filtroDepartamento !== departamentoAssinado) escutarQuadro();
}

function escutarDepartamentos() {
  onSnapshot(
    collection(db, COLECAO_DEPARTAMENTOS),
    (snap) => {
      DEPARTAMENTOS_FULL = snap.docs
        .map((d) => ({
          id: d.id,
          nome: (d.data().nome || "").trim(),
          colunas: lerColunas(d.data()),
          subtarefasPadrao: lerPadroes(d.data())
        }))
        .filter((d) => d.nome)
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

      DEPARTAMENTOS = DEPARTAMENTOS_FULL.map((d) => d.nome);

      const modalAtual = $("fDepartamento").value;
      preencherSelectsDepartamento();
      if (DEPARTAMENTOS.includes(modalAtual)) $("fDepartamento").value = modalAtual;

      lembrarDepartamento();
      reassinarCardsSeMudou();
      render();
    },
    (erro) => {
      console.error("[kanban] falha ao ler departamentos:", erro);
      if (erro.code === "permission-denied") {
        setStatus(
          "Sem permissao para ler os departamentos. Publique o conteudo de " +
            "firestore.rules no Firebase Console (Firestore -> Regras).",
          true
        );
      }
    }
  );
}

// O departamento escolhido fica guardado neste navegador, para o quadro abrir
// no mesmo lugar da ultima vez.
const CHAVE_DEP = "kanban-departamento";

function lembrarDepartamento() {
  try {
    if (filtroDepartamento) localStorage.setItem(CHAVE_DEP, filtroDepartamento);
  } catch (e) { /* localStorage bloqueado */ }
}

function recuperarDepartamento() {
  try {
    filtroDepartamento = localStorage.getItem(CHAVE_DEP) || "";
  } catch (e) { /* ignora */ }
}

/* --------------------------------------------------------------------------
   6. Render
   -------------------------------------------------------------------------- */

function render() {
  groupsEl.innerHTML = "";

  if (!filtroDepartamento) {
    groupsEl.innerHTML =
      '<p class="aviso-sem-dep">Escolha um departamento no topo para ver o quadro dele.</p>';
    return;
  }

  // Uma coluna por lista, na ordem cadastrada para o departamento.
  COLUNAS.forEach((col) => {
    const gDiv = document.createElement("div");
    gDiv.className = "group";

    const colsDiv = document.createElement("div");
    colsDiv.className = "group-cols";
    colsDiv.appendChild(renderColuna(col));

    gDiv.appendChild(colsDiv);
    groupsEl.appendChild(gDiv);
  });
}

function renderColuna(col) {
  const colDiv = document.createElement("div");
  colDiv.className = "column";
  colDiv.dataset.colId = col.id;

  const visiveis = cardsVisiveis(col.id);

  const header = document.createElement("div");
  header.className = "col-header";
  header.innerHTML =
    `<button class="add-btn" title="Nova tarefa em ${escapeHtml(col.titulo)}" aria-label="Nova tarefa em ${escapeHtml(col.titulo)}">+</button>` +
    `<span class="col-title">${escapeHtml(col.titulo)}</span>` +
    `<span class="col-count">${visiveis.length}</span>`;
  header.querySelector(".add-btn").onclick = () => abrirModal(col.id, null);
  colDiv.appendChild(header);

  const list = document.createElement("div");
  list.className = "card-list";
  list.dataset.colId = col.id;

  if (!visiveis.length) {
    const vazio = document.createElement("div");
    vazio.className = "col-empty";
    vazio.textContent = filtroDepartamento ? "nada neste filtro" : "sem tarefas";
    list.appendChild(vazio);
  } else {
    visiveis.forEach((card) => list.appendChild(renderCard(col, card)));
  }

  colDiv.appendChild(list);

  // --- alvo de drop -------------------------------------------------------
  colDiv.addEventListener("dragover", (e) => {
    if (!arrastando) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    colDiv.classList.add("drop-hover");
  });
  colDiv.addEventListener("dragleave", (e) => {
    if (!colDiv.contains(e.relatedTarget)) colDiv.classList.remove("drop-hover");
  });
  colDiv.addEventListener("drop", async (e) => {
    e.preventDefault();
    colDiv.classList.remove("drop-hover");
    const cardId = arrastando || e.dataTransfer.getData("text/plain");
    arrastando = null;
    if (!cardId) return;
    await soltarCard(cardId, col.id);
  });

  return colDiv;
}

function renderCard(col, card) {
  const alteravel = podeAlterar(card);

  const div = document.createElement("div");
  div.className = "task-card p-" + card.prioridade + (alteravel ? "" : " so-leitura");
  div.draggable = alteravel;              // so arrasta quem pode alterar
  div.dataset.id = card.id;

  const indiceCol = COLUNAS.findIndex((c) => c.id === col.id);

  div.innerHTML = `
    ${renderBolinha(card, col)}
    <div class="task-title">${escapeHtml(card.titulo)}</div>
    ${card.descricao ? `<div class="task-desc">${escapeHtml(card.descricao)}</div>` : ""}
    ${card.departamento
      ? `<div class="task-tags"><span class="tag-dept">${escapeHtml(card.departamento)}</span></div>`
      : ""}
    ${renderDatas(card, col)}
    ${renderRetencao(card, col)}
    ${renderSubtarefas(card, col)}
    <div class="task-meta">
      <div class="meta-left">
        <div class="avatar ${card.responsavel ? "" : "vazio"}" title="${escapeHtml(card.responsavel || "sem responsável")}">${escapeHtml(iniciais(card.responsavel))}</div>
        <span class="meta-date">${escapeHtml(formatarData(card.criadoEm))}</span>
      </div>
      <div class="task-buttons">
        <button class="icon-btn" data-action="left" title="Mover para trás" ${(!alteravel || indiceCol === 0) ? "disabled" : ""}>←</button>
        <button class="icon-btn" data-action="edit" title="${alteravel ? "Editar" : "Ver"}">${alteravel ? "✎" : "🔍"}</button>
        <button class="icon-btn" data-action="right" title="Mover para frente" ${(!alteravel || indiceCol === COLUNAS.length - 1) ? "disabled" : ""}>→</button>
      </div>
    </div>
  `;

  if (alteravel) {
    div.querySelectorAll(".sub").forEach((li) => {
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        avancarSubtarefa(card.id, li.dataset.sub);
      });
    });
  }

  div.addEventListener("dragstart", (e) => {
    arrastando = card.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
    div.classList.add("dragging");
  });
  div.addEventListener("dragend", () => {
    arrastando = null;
    div.classList.remove("dragging");
  });

  div.querySelector('[data-action="edit"]').onclick = () => abrirModal(col.id, card.id);
  div.querySelector('[data-action="left"]').onclick  = () => moverColunaVizinha(card.id, -1);
  div.querySelector('[data-action="right"]').onclick = () => moverColunaVizinha(card.id, 1);

  return div;
}

// Repassa para o modulo de cronograma, informando se a coluna e a de
// conclusao (onde nao ha mais prazo a cobrar).
function progressoPrazo(card, col) {
  return progressoPrazoBase(card, col.id === colunaFinal());
}

// Bolinha no canto superior direito. A cor percorre o circulo HSL de 120 (verde)
// ate 0 (vermelho), passando por 60 (amarelo) na metade do prazo.
function renderBolinha(card, col) {
  // Todas as etapas concluidas: bolinha verde e sem contagem de prazo.
  if (progresso(card.subtarefas || []).completo) {
    return `<span class="task-dot" style="background:var(--live-green)" title="Todas as etapas concluídas"></span>`;
  }
  const p = progressoPrazo(card, col);
  if (p === null) return "";

  const cor = corDoPrazo(p);

  const fim = new Date(card.fimPrevisto + "T00:00:00");
  const hoje = new Date(hojeISO() + "T00:00:00");
  const dias = Math.round((fim - hoje) / MS_POR_DIA);

  let texto;
  if (dias < 0) texto = `Atrasada ${-dias} ${dias === -1 ? "dia" : "dias"} (previsto ${formatarDataISO(card.fimPrevisto)})`;
  else if (dias === 0) texto = `Termina hoje (${formatarDataISO(card.fimPrevisto)})`;
  else texto = `Faltam ${dias} ${dias === 1 ? "dia" : "dias"} para ${formatarDataISO(card.fimPrevisto)}`;

  return `<span class="task-dot" style="background:${cor}" title="${escapeHtml(texto)}"></span>`;
}

// Repassa para o modulo de cronograma (ver coresDasSubtarefas la).
function coresDasSubtarefas(card, col) {
  return coresDasSubtarefasBase(card, col.id === colunaFinal());
}

// Etapas da tarefa. Cada uma mostra o estado e avanca no clique:
// a fazer -> fazendo -> feito -> a fazer.
function renderSubtarefas(card, col) {
  const subs = card.subtarefas || [];
  if (!subs.length) return "";

  const { feitas, total, completo } = progresso(subs);
  const cores = coresDasSubtarefas(card, col);

  const janelas = janelasDasSubtarefas(card);

  const itens = subs
    .map((sub, i) => {
      const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;
      const cor = cores.get(sub.id);
      const estilo = cor ? ` style="--cor-sub:${cor}"` : "";
      const coment = (sub.comentario || "").trim();
      const dica = tituloSubtarefa(sub, janelas.get(sub.id)) + (coment ? ` · 💬 ${coment}` : "");
      return `<li class="sub ${sub.estado}${cor ? " colorida" : ""}" data-sub="${escapeHtml(sub.id)}"
                  title="${escapeHtml(dica)}"${estilo}>
        <span class="sub-icone">${info.icone}</span>
        <span class="sub-num">1-${i + 1}</span>
        <span class="sub-nome">${escapeHtml(sub.nome)}</span>
        ${coment ? '<span class="sub-coment-flag">&#128172;</span>' : ""}
      </li>`;
    })
    .join("");

  return `<div class="task-subs${completo ? " completo" : ""}">
    <div class="subs-topo">
      <span>Subtarefas</span>
      <span class="subs-contagem">${feitas}/${total}</span>
    </div>
    <ul class="subs-lista">${itens}</ul>
  </div>`;
}

// Avanca o estado de uma etapa direto no card, sem abrir o modal.
async function avancarSubtarefa(cardId, subId) {
  const card = cardPorId(cardId);
  if (!card || !podeAlterar(card)) return;

  const anterior = (card.subtarefas || []).find((s) => s.id === subId);
  if (!anterior) return;

  const novas = (card.subtarefas || []).map((s) =>
    s.id === subId ? { ...s, estado: proximoEstado(s.estado) } : s
  );
  const depois = novas.find((s) => s.id === subId);

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      subtarefas: novas,
      atualizadoEm: serverTimestamp()
    });
    registrarEstadoSubtarefa(card, anterior, anterior.estado, depois.estado, quemSouEu());
  } catch (e) {
    console.error("[kanban] falha ao atualizar subtarefa:", e);
    setStatus("Nao foi possivel atualizar a etapa.", true);
  }
}

// Faixa "inicio -> termino" do card. Fica vermelha se o termino previsto ja
// passou e a tarefa ainda nao esta em Finalizado; laranja se vence hoje.
function renderDatas(card, col) {
  if (!card.inicioPrevisto && !card.fimPrevisto) return "";

  const hoje = hojeISO();
  const finalizada = col.id === "finalizado";
  let classe = "";
  let titulo = "Projeção: início → término";

  if (!finalizada && card.fimPrevisto) {
    if (card.fimPrevisto < hoje) { classe = " atrasada"; titulo = "Término previsto já passou"; }
    else if (card.fimPrevisto === hoje) { classe = " hoje"; titulo = "Término previsto para hoje"; }
  }

  const ini = card.inicioPrevisto ? formatarDataISO(card.inicioPrevisto) : "—";
  const fim = card.fimPrevisto ? formatarDataISO(card.fimPrevisto) : "—";

  return `<div class="task-dates${classe}" title="${titulo}">
    <span>📅</span><span>${escapeHtml(ini)}</span><span class="arrow">→</span><span>${escapeHtml(fim)}</span>
  </div>`;
}

// Na ultima coluna, mostra desde quando a tarefa esta no quadro final (a data
// em que ela foi colocada la). Nao ha mais remocao automatica por tempo: a
// tarefa sai do quadro quando alguem clica em "Finalizar".
function renderRetencao(card, col) {
  if (col.id !== colunaFinal()) return "";
  const d = finalizadaEm(card);
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const txt = `${dd}/${mm}/${d.getFullYear()}`;
  return `<div class="task-retencao" title="No último quadro desde ${txt}">
    <span>🏁</span><span>no quadro final desde ${txt}</span>
  </div>`;
}

/* --------------------------------------------------------------------------
   7. Movimentacao (drag & drop e setas)
   -------------------------------------------------------------------------- */

// Marca/limpa o inicio da contagem de retencao ao entrar ou sair de "Finalizado".
function carimboFinalizacao(colunaAntes, colunaDepois) {
  if (colunaDepois === colunaFinal() && colunaAntes !== colunaFinal()) {
    return { finalizadoEm: serverTimestamp() };
  }
  if (colunaAntes === colunaFinal() && colunaDepois !== colunaFinal()) {
    return { finalizadoEm: null }; // reaberta: a contagem zera
  }
  return {};
}

// Soltar um card so muda a COLUNA. A posicao dentro dela e sempre calculada
// pelo prazo de termino (ver cardsDaColuna), entao nao ha ordem manual para
// gravar nem posicao de insercao para descobrir.
async function soltarCard(cardId, colunaDestino) {
  const card = cardPorId(cardId);
  if (!card || card.coluna === colunaDestino) return;
  if (!podeAlterar(card)) {
    setStatus("Só o dono, o responsável ou um administrador pode mover esta tarefa.", true);
    return;
  }

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      coluna: colunaDestino,
      atualizadoEm: serverTimestamp(),
      ...carimboFinalizacao(card.coluna, colunaDestino)
    });
    registrarMovimento(card, nomeDaLista(card.coluna), nomeDaLista(colunaDestino), quemSouEu());
  } catch (e) {
    console.error("[kanban] falha ao mover card:", e);
    setStatus("Não foi possível mover a tarefa. Tente de novo.", true);
  }
}

async function moverColunaVizinha(cardId, direcao) {
  const card = cardPorId(cardId);
  if (!card || !podeAlterar(card)) return;

  const idx = COLUNAS.findIndex((c) => c.id === card.coluna);
  const destino = COLUNAS[idx + direcao];
  if (!destino) return;

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      coluna: destino.id,
      atualizadoEm: serverTimestamp(),
      ...carimboFinalizacao(card.coluna, destino.id)
    });
    registrarMovimento(card, nomeDaLista(card.coluna), nomeDaLista(destino.id), quemSouEu());
  } catch (e) {
    console.error("[kanban] falha ao mover card:", e);
    setStatus("Não foi possível mover a tarefa. Tente de novo.", true);
  }
}

/* --------------------------------------------------------------------------
   8. Modal + CRUD
   -------------------------------------------------------------------------- */

function departamentosDisponiveis() {
  if (!usuario || usuario.permissao.veTudo) return DEPARTAMENTOS;
  return DEPARTAMENTOS.filter((d) => usuario.permissao.departamentos.includes(d));
}

// Pessoas que podem aparecer como responsavel num departamento: os cadastrados
// nele (kanban_acessos) mais quem ja figura como responsavel nas tarefas
// carregadas desse departamento.
function pessoasDoDepartamento(dep) {
  const mapa = new Map(); // email -> nome
  if (!dep) return [];
  PESSOAS.forEach((p) => {
    if ((p.departamentos || []).includes(dep)) mapa.set(p.email, p.nome);
  });
  cards.forEach((c) => {
    if ((c.departamento || "") === dep && c.responsavelEmail && !mapa.has(c.responsavelEmail)) {
      mapa.set(c.responsavelEmail, c.responsavel || nomeDoEmail(c.responsavelEmail));
    }
  });
  return Array.from(mapa, ([email, nome]) => ({ email, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

// Preenche o seletor de Responsavel conforme o papel:
//   . usuario comum    -> travado nele mesmo (so ve as proprias tarefas)
//   . admin/supervisor -> "Todos" + as pessoas do departamento selecionado
function preencherSelectResponsavel() {
  if (!filtroRespSel) return;

  if (soVeProprias()) {
    // Usuario comum: ve as proprias + as sem responsavel (o servidor ja traz
    // exatamente isso). O seletor fica so informativo.
    filtroResponsavel = "";
    filtroRespSel.innerHTML = '<option value="">Minhas e sem responsável</option>';
    filtroRespSel.value = "";
    filtroRespSel.disabled = true;
    return;
  }

  filtroRespSel.disabled = false;
  const pessoas = pessoasDoDepartamento(filtroDepartamento);
  filtroRespSel.innerHTML = '<option value="">Todos</option>' +
    pessoas.map((p) => `<option value="${escapeHtml(p.email)}">${escapeHtml(p.nome)}</option>`).join("");

  // Mantem a selecao se o responsavel ainda existe na lista; senao, "Todos".
  if (filtroResponsavel && pessoas.some((p) => p.email === filtroResponsavel)) {
    filtroRespSel.value = filtroResponsavel;
  } else {
    filtroResponsavel = "";
    filtroRespSel.value = "";
  }
}

// O seletor do topo escolhe o departamento de trabalho - nao existe "Todos",
// porque cada departamento tem seu proprio fluxo de listas.
function preencherSelectsDepartamento() {
  const lista = departamentosDisponiveis();

  filtroSel.innerHTML = lista.length
    ? lista.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")
    : '<option value="">— nenhum departamento —</option>';

  // mantem o que ja estava escolhido; senao, o primeiro da lista
  if (lista.includes(filtroDepartamento)) filtroSel.value = filtroDepartamento;
  else filtroDepartamento = filtroSel.value = lista[0] || "";

  aplicarFluxoDoDepartamento();

  // No modal o departamento acompanha o quadro, mas pode ser trocado para
  // mover a tarefa para outro departamento.
  const selModal = $("fDepartamento");
  selModal.innerHTML = lista
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
    .join("");
}

// Troca o conjunto de colunas conforme o departamento de trabalho.
function aplicarFluxoDoDepartamento() {
  const dep = DEPARTAMENTOS_FULL.find((d) => d.nome === filtroDepartamento);
  COLUNAS = colunasDe(dep).map((c) => ({ ...c, titulo: c.nome }));
}

// Deixa o modal em modo leitura (true) ou edicao (false): desabilita todos os
// campos e esconde Salvar + a caixa de adicionar etapa. O Cancelar fica ativo.
// Chamar DEPOIS de renderSubsModal(), para pegar tambem os campos das etapas.
function setModalSomenteLeitura(ro) {
  const modal = overlay.querySelector(".modal");
  modal.querySelectorAll("input, textarea, select").forEach((el) => { el.disabled = ro; });
  modal.querySelectorAll(".sub-estado, .sub-remover, .sub-mover, .sub-comentar").forEach((b) => { b.disabled = ro; });
  $("saveBtn").style.display = ro ? "none" : "";
  const addBox = $("addSubBox");
  if (addBox) addBox.style.display = ro ? "none" : "";
}

function abrirModal(colunaId, cardId) {
  editando = { colunaId, cardId };
  const ehEdicao = !!cardId;

  $("modalTitle").textContent = ehEdicao ? "Editar tarefa" : "Nova tarefa";
  erroModal.textContent = "";

  if (ehEdicao) {
    const card = cardPorId(cardId);
    if (!card) return; // card apagado por outra pessoa enquanto a tela estava aberta
    $("fTitle").value = card.titulo;
    $("fDesc").value = card.descricao || "";
    $("fDepartamento").value = card.departamento || "";
    $("fAssignee").value = card.responsavel || "";
    montarSugestoes(card.responsavel);
    $("fPriority").value = card.prioridade;
    $("fInicio").value = card.inicioPrevisto || "";
    $("fFim").value = card.fimPrevisto || "";
    subsRascunho = (card.subtarefas || []).map((x) => ({ ...x }));
    renderSubsModal();
    mostrarDono(card.criadoPor);

    // Dono, responsavel ou admin alteram tudo; os demais so visualizam.
    const alteravel = podeAlterar(card);
    setModalSomenteLeitura(!alteravel);
    $("modalTitle").textContent = alteravel ? "Editar tarefa" : "Ver tarefa (somente leitura)";
    configurarBotaoSaida(card, alteravel);
    $("hintDono").textContent = !alteravel
      ? "Você não pode alterar esta tarefa — só o dono, o responsável ou um administrador."
      : card.criadoPor === usuario.email
        ? "Você criou esta tarefa, então pode alterá-la e excluí-la."
        : ehOResponsavel(card)
          ? "Você é o responsável, então pode alterá-la e excluí-la."
          : "Você é administrador, então pode alterá-la e excluí-la.";
  } else {
    $("fTitle").value = "";
    $("fDesc").value = "";
    $("fDepartamento").value = filtroDepartamento || "";
    $("fAssignee").value = usuario ? nomeDoEmail(usuario.email) : "";
    montarSugestoes();
    $("fPriority").value = "media";
    $("fInicio").value = "";
    $("fFim").value = "";
    // tarefa nova ja nasce com o roteiro padrao do departamento
    const dep = DEPARTAMENTOS_FULL.find((d) => d.nome === filtroDepartamento);
    subsRascunho = subtarefasIniciais(dep ? dep.subtarefasPadrao : []);
    renderSubsModal();
    mostrarDono(usuario ? usuario.email : "");
    setModalSomenteLeitura(false);
    $("deleteBtn").style.display = "none";
    const fb = $("fFinalizadoBox");
    if (fb) fb.style.display = "none";
    $("hintDono").textContent = "Quem cria a tarefa é o dono e pode alterá-la e excluí-la depois.";
  }

  const cardAtual = cardId ? cardPorId(cardId) : null;
  configurarResponsavelModal(cardAtual, ehEdicao);

  overlay.classList.add("show");
  $("fTitle").focus();
}

// Ajusta o campo Responsavel e o botao "Pegar para mim" conforme o papel:
// o usuario comum nunca digita responsavel (nao pode atribuir a outra pessoa);
// em tarefa existente sem responsavel, ele ganha o botao para pegar para si.
function configurarResponsavelModal(card, ehEdicao) {
  const campo = $("fAssignee");
  const pegar = $("pegarBtn");
  const comum = soVeProprias();

  if (pegar) pegar.disabled = false;

  if (comum) {
    campo.disabled = true; // comum nunca digita responsavel
    $("hintResponsavel").textContent =
      "Você só pode pegar a tarefa para você. Supervisores e administradores atribuem a outras pessoas.";
    $("hintResponsavel").classList.remove("erro");
  }

  const mostrarPegar = comum && ehEdicao && !!card && podePegar(card);
  if (pegar) pegar.style.display = mostrarPegar ? "inline-flex" : "none";
}

// Usuario comum pega uma tarefa sem responsavel para si (grava direto).
async function pegarTarefaParaMim() {
  if (!usuario || !editando.cardId) return;
  const card = cardPorId(editando.cardId);
  if (!card || !podePegar(card)) return;

  const meuNome = nomeDoEmail(usuario.email);
  const pegar = $("pegarBtn");
  pegar.disabled = true;
  try {
    await updateDoc(doc(db, COLECAO_CARDS, editando.cardId), {
      responsavel: meuNome,
      responsavelEmail: usuario.email,
      atualizadoEm: serverTimestamp()
    });
    registrarEdicao(
      card,
      { ...card, responsavel: meuNome, responsavelEmail: usuario.email },
      quemSouEu(),
      nomeDaLista
    );
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao pegar tarefa:", e);
    erroModal.textContent = "Não foi possível pegar a tarefa. Tente novamente.";
    pegar.disabled = false;
  }
}

// Na ultima coluna o botao de saida vira "Finalizar" (arquiva em
// cards_finalizados); nas demais ele "Exclui" (cancela -> cards_cancelados).
// Tambem mostra desde quando a tarefa esta no quadro final.
function configurarBotaoSaida(card, alteravel) {
  const btn = $("deleteBtn");
  const fb = $("fFinalizadoBox");
  const naFinal = card.coluna === colunaFinal();
  const d = naFinal ? finalizadaEm(card) : null;

  if (fb) {
    if (d) {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      fb.textContent = `No último quadro desde ${dd}/${mm}/${d.getFullYear()}`;
      fb.style.display = "";
    } else {
      fb.style.display = "none";
    }
  }

  if (!alteravel) { btn.style.display = "none"; return; }
  btn.style.display = "inline";
  if (naFinal) {
    btn.textContent = "Finalizar tarefa";
    btn.dataset.acao = "finalizar";
    btn.classList.add("finalizar");
  } else {
    btn.textContent = "Excluir tarefa";
    btn.dataset.acao = "cancelar";
    btn.classList.remove("finalizar");
  }
}

// Mostra o dono pelo nome ("marcos.centrone@..." -> "Marcos Centrone").
function mostrarDono(email) {
  const el = $("fDono");
  if (!email || !email.includes("@")) {
    el.textContent = "— não registrado —";
    el.className = "campo-dono vazio";
    return;
  }
  const souEu = usuario && email === usuario.email;
  el.className = "campo-dono";
  el.innerHTML =
    `<span>${escapeHtml(nomeDoEmail(email))}</span>` +
    (souEu ? '<span class="voce">você</span>' : "");
  el.title = email;
}

/* ---- Subtarefas dentro do modal ----------------------------------------- */

// Rascunho: as etapas so vao para o Firestore quando a tarefa e salva.
let subsRascunho = [];

// Sugestoes para o campo "Nova etapa": as subtarefas-padrao do departamento da
// tarefa que ainda nao foram adicionadas. A pessoa pode escolher uma delas ou
// digitar uma etapa nova.
function montarSugestoesSub() {
  const lista = $("listaSubsPadrao");
  if (!lista) return;
  const depNome = $("fDepartamento") ? $("fDepartamento").value : "";
  const dep = DEPARTAMENTOS_FULL.find((d) => d.nome === depNome);
  const padroes = dep ? (dep.subtarefasPadrao || []) : [];
  const jaUsados = new Set(subsRascunho.map((s) => (s.nome || "").trim().toLowerCase()));

  lista.innerHTML = padroes
    .filter((n) => n && !jaUsados.has(n.trim().toLowerCase()))
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

function renderSubsModal() {
  const box = $("subsModal");
  const form = $("addSubBox");

  $("contaSubsModal").textContent = `${subsRascunho.length}/${MAX_SUBTAREFAS}`;
  form.style.display = subsRascunho.length >= MAX_SUBTAREFAS ? "none" : "flex";
  montarSugestoesSub();

  if (!subsRascunho.length) {
    box.innerHTML = '<p class="subs-vazio">Nenhuma etapa. Adicione abaixo, se precisar.</p>';
    return;
  }

  box.innerHTML = "";
  subsRascunho.forEach((sub, i) => {
    const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;
    const temComent = !!(sub.comentario && sub.comentario.trim());

    const item = document.createElement("div");
    item.className = "sub-item";

    const linha = document.createElement("div");
    linha.className = "sub-linha " + sub.estado;
    linha.innerHTML = `
      <button type="button" class="sub-estado" title="${info.rotulo}">${info.icone}</button>
      <span class="sub-num">1-${i + 1}</span>
      <input class="sub-input" maxlength="40" value="${escapeHtml(sub.nome)}">
      <button type="button" class="sub-mover" data-dir="-1" title="Subir" ${i === 0 ? "disabled" : ""}>&#8593;</button>
      <button type="button" class="sub-mover" data-dir="1" title="Descer" ${i === subsRascunho.length - 1 ? "disabled" : ""}>&#8595;</button>
      <button type="button" class="sub-comentar${temComent ? " tem" : ""}" title="Comentário (até 50 caracteres)">&#128172;</button>
      <button type="button" class="sub-remover" title="Remover">&times;</button>
    `;

    const comentBox = document.createElement("div");
    comentBox.className = "sub-comentario";
    comentBox.style.display = temComent ? "flex" : "none";
    comentBox.innerHTML =
      `<input class="sub-coment-input" maxlength="50" placeholder="Comentário (até 50 caracteres)" value="${escapeHtml(sub.comentario || "")}">`;

    linha.querySelector(".sub-estado").onclick = () => {
      subsRascunho[i].estado = proximoEstado(subsRascunho[i].estado);
      renderSubsModal();
    };
    linha.querySelector(".sub-input").oninput = (e) => {
      subsRascunho[i].nome = e.target.value;
    };
    linha.querySelectorAll(".sub-mover").forEach((b) => {
      b.onclick = () => moverSubRascunho(i, Number(b.dataset.dir));
    });
    linha.querySelector(".sub-comentar").onclick = () => {
      const escondido = comentBox.style.display === "none";
      comentBox.style.display = escondido ? "flex" : "none";
      if (escondido) comentBox.querySelector("input").focus();
    };
    comentBox.querySelector("input").oninput = (e) => {
      subsRascunho[i].comentario = e.target.value.slice(0, 50);
      linha.querySelector(".sub-comentar").classList.toggle("tem", !!subsRascunho[i].comentario.trim());
    };
    linha.querySelector(".sub-remover").onclick = () => {
      subsRascunho.splice(i, 1);
      renderSubsModal();
    };

    item.appendChild(linha);
    item.appendChild(comentBox);
    box.appendChild(item);
  });
}

// Troca a etapa de posicao (subir/descer). Mesma permissao de editar a tarefa:
// quando o modal esta em leitura, os botoes ja ficam desabilitados.
function moverSubRascunho(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= subsRascunho.length) return;
  const tmp = subsRascunho[i];
  subsRascunho[i] = subsRascunho[j];
  subsRascunho[j] = tmp;
  renderSubsModal();
}

function adicionarSubRascunho() {
  const campo = $("novaSubModal");
  const nome = campo.value.trim();
  if (!nome || subsRascunho.length >= MAX_SUBTAREFAS) return;

  subsRascunho.push({
    id: gerarIdSubtarefa(subsRascunho.map((s) => s.id)),
    nome,
    estado: "pendente"
  });
  campo.value = "";
  renderSubsModal();
}

$("addSub").onclick = adicionarSubRascunho;
$("novaSubModal").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); adicionarSubRascunho(); }
});

function fecharModal() {
  overlay.classList.remove("show");
  editando = { colunaId: null, cardId: null };
}

async function salvarTarefa() {
  // Blindagem: editar uma tarefa existente exige permissao. O modal ja entra
  // em modo leitura para quem nao pode, mas o atalho Ctrl+Enter chamaria esta
  // funcao mesmo assim - entao barramos aqui tambem.
  if (editando.cardId) {
    const atual = cardPorId(editando.cardId);
    if (atual && !podeAlterar(atual)) {
      erroModal.textContent = "Você não pode alterar esta tarefa.";
      return;
    }
  }

  const titulo = $("fTitle").value.trim();
  if (!titulo) {
    erroModal.textContent = "Informe um título para a tarefa.";
    $("fTitle").focus();
    return;
  }

  const responsavel = $("fAssignee").value.trim();
  const originalResp = editando.cardId ? (cardPorId(editando.cardId)?.responsavel || "") : "";
  if (!responsavelValido(responsavel, originalResp)) {
    erroModal.textContent =
      `"${responsavel}" não está cadastrado. Escolha alguém da lista — ` +
      "novos nomes são cadastrados na área administrativa.";
    $("fAssignee").focus();
    return;
  }

  const inicioPrevisto = $("fInicio").value; // "AAAA-MM-DD" ou ""
  const fimPrevisto = $("fFim").value;
  if (inicioPrevisto && fimPrevisto && fimPrevisto < inicioPrevisto) {
    erroModal.textContent = "O término previsto não pode ser antes do início.";
    $("fFim").focus();
    return;
  }

  const subtarefas = subsRascunho
    .map((x) => ({ ...x, nome: (x.nome || "").trim() }))
    .filter((x) => x.nome)
    .slice(0, MAX_SUBTAREFAS);

  const dados = {
    titulo,
    descricao: $("fDesc").value.trim(),
    departamento: $("fDepartamento").value,
    responsavel,
    responsavelEmail: emailDoResponsavel(responsavel),
    prioridade: $("fPriority").value,
    subtarefas,
    inicioPrevisto,
    fimPrevisto,
    atualizadoEm: serverTimestamp()
  };

  const btn = $("saveBtn");
  btn.disabled = true;

  try {
    if (editando.cardId) {
      // Fotografia de antes, para a auditoria comparar campo a campo.
      const antes = { ...cardPorId(editando.cardId) };
      await updateDoc(doc(db, COLECAO_CARDS, editando.cardId), dados);
      registrarEdicao(
        antes,
        { ...antes, ...dados, subtarefas },
        quemSouEu(),
        nomeDaLista
      );
    } else {
      const novo = {
        ...dados,
        coluna: editando.colunaId,
        criadoEm: serverTimestamp(),
        criadoPor: usuario ? usuario.email : ""
      };
      const ref = await addDoc(cardsRef, novo);
      registrarCriacao({ ...novo, id: ref.id }, quemSouEu());
    }
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao salvar:", e);
    erroModal.textContent = "Erro ao salvar no Firestore. Verifique a conexão.";
  } finally {
    btn.disabled = false;
  }
}

// Campos do card copiados para a colecao de arquivo.
function dadosParaArquivo(card) {
  return {
    titulo: card.titulo || "",
    descricao: card.descricao || "",
    coluna: card.coluna || "",
    departamento: card.departamento || "",
    responsavel: card.responsavel || "",
    responsavelEmail: card.responsavelEmail || "",
    prioridade: card.prioridade || "media",
    inicioPrevisto: card.inicioPrevisto || "",
    fimPrevisto: card.fimPrevisto || "",
    finalizadoEm: card.finalizadoEm || null,
    criadoPor: card.criadoPor || "",
    criadoEm: card.criadoEm || null,
    subtarefas: card.subtarefas || []
  };
}

// Move a tarefa de kanban_cards para uma colecao de arquivo, num lote atomico:
// ou grava o arquivo e apaga do quadro, ou nada acontece.
async function arquivarTarefa(card, colecao, status) {
  const lote = writeBatch(db);
  lote.set(doc(db, colecao, card.id), {
    ...dadosParaArquivo(card),
    status,
    arquivadoEm: serverTimestamp(),
    arquivadoPor: usuario ? usuario.email : ""
  });
  lote.delete(doc(db, COLECAO_CARDS, card.id));
  await lote.commit();
}

async function finalizarTarefa() {
  const card = cardPorId(editando.cardId);
  if (!card) { fecharModal(); return; }
  if (!podeAlterar(card)) {
    erroModal.textContent = "Só o dono, o responsável, o supervisor ou um administrador pode finalizar esta tarefa.";
    return;
  }
  if (!confirm(`Finalizar a tarefa "${card.titulo}"?\n\nEla sai do quadro e passa a aparecer só no relatório.`)) return;
  try {
    await arquivarTarefa(card, COLECAO_FINALIZADOS, "finalizado");
    registrarFinalizacao(card, quemSouEu());
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao finalizar:", e);
    erroModal.textContent = "Erro ao finalizar. Tente novamente.";
  }
}

async function cancelarTarefa() {
  const card = cardPorId(editando.cardId);
  if (!card) { fecharModal(); return; }
  if (!podeAlterar(card)) {
    erroModal.textContent = "Só o dono, o responsável, o supervisor ou um administrador pode excluir esta tarefa.";
    return;
  }
  if (!confirm(`Excluir a tarefa "${card.titulo}"?\n\nEla sai do quadro e fica registrada como cancelada no relatório.`)) return;
  try {
    await arquivarTarefa(card, COLECAO_CANCELADOS, "cancelado");
    registrarCancelamento(card, quemSouEu());
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao cancelar:", e);
    erroModal.textContent = "Erro ao excluir. Tente novamente.";
  }
}

/* --------------------------------------------------------------------------
   10. Ligacoes de eventos + boot
   -------------------------------------------------------------------------- */

$("saveBtn").onclick = salvarTarefa;
$("deleteBtn").onclick = () => {
  if ($("deleteBtn").dataset.acao === "finalizar") finalizarTarefa();
  else cancelarTarefa();
};
$("pegarBtn").onclick = pegarTarefaParaMim;
$("cancelBtn").onclick = fecharModal;

// O modal so fecha pelos botoes (Cancelar / Salvar / Excluir / Pegar) - clicar
// fora ou apertar Esc nao fecha, para nao perder o que foi digitado sem querer.
document.addEventListener("keydown", (e) => {
  if (!overlay.classList.contains("show")) return;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) salvarTarefa();
});

// Aviso imediato: o campo fica vermelho assim que o texto deixa de bater com
// alguem cadastrado, em vez de so reclamar na hora de salvar.
$("fAssignee").addEventListener("input", () => {
  const campo = $("fAssignee");
  const original = editando.cardId ? (cardPorId(editando.cardId)?.responsavel || "") : "";
  const ok = responsavelValido(campo.value, original);
  campo.classList.toggle("invalido", !ok);
  $("hintResponsavel").textContent = ok
    ? "Comece a digitar para ver quem está cadastrado. Pode ser outra pessoa."
    : "Nome não cadastrado — escolha alguém da lista.";
  $("hintResponsavel").classList.toggle("erro", !ok);
});

// Trocar o departamento no modal refaz as sugestoes de responsavel (so as
// pessoas daquele departamento) e limpa o nome se ele nao faz parte do novo.
$("fDepartamento").addEventListener("change", () => {
  const nome = $("fAssignee").value.trim();
  const dep = $("fDepartamento").value;
  const aindaVale = !nome || PESSOAS.some(
    (p) => p.nome.toLowerCase() === nome.toLowerCase() && (p.departamentos || []).includes(dep)
  );
  if (!aindaVale) $("fAssignee").value = "";
  montarSugestoes($("fAssignee").value.trim());
  montarSugestoesSub();
});

filtroSel.addEventListener("change", () => {
  filtroDepartamento = filtroSel.value;
  filtroResponsavel = "";            // novo departamento = outras pessoas
  aplicarFluxoDoDepartamento();
  lembrarDepartamento();
  preencherSelectResponsavel();
  escutarQuadro();   // re-assina os cards do novo departamento
  render();
});

// Filtro de responsavel: afina o que o quadro mostra (no cliente). Para o
// usuario comum o seletor fica travado nele, entao este handler nem dispara.
filtroRespSel.addEventListener("change", () => {
  filtroResponsavel = filtroRespSel.value;
  render();
});

// O contador de dias muda com o tempo, nao com os dados: sem isto uma aba
// deixada aberta mostraria "sai em 3 dias" para sempre.
setInterval(render, 60 * 60 * 1000);

// O atalho para a area administrativa aparece para quem e administrador e
// tambem enquanto NENHUM administrador existir - senao o primeiro acesso nao
// teria por onde entrar para se cadastrar.
function mostrarAtalhoAdmin(logado) {
  const link = $("linkAdmin");
  if (!link) return;

  // Admin e supervisor abrem a Configuracao (o supervisor numa versao limitada).
  // Em modo aberto (setup inicial), qualquer logado abre, para cadastrar o
  // primeiro administrador. O dono entra sempre, pois e admin pela regra.
  const abreConfig = logado.permissao.admin || logado.permissao.supervisor || ADMIN_ABERTO;

  if (abreConfig) {
    link.style.display = "inline-flex";
    if (ADMIN_ABERTO && !logado.permissao.admin && !logado.permissao.supervisor) {
      link.classList.add("primeiro-acesso");
      link.title = "Área administrativa (modo aberto — cadastre o primeiro administrador)";
    }
    return;
  }

  // Usuario comum: o atalho leva direto ao Relatorio (so Relatorio e Auditoria,
  // a aba Configuracao fica oculta la dentro).
  link.href = "relatorio.html";
  link.title = "Relatórios e auditoria";
  link.setAttribute("aria-label", "Relatórios e auditoria");
  link.style.display = "inline-flex";
}

// Nada roda antes do login: protegerPagina() so resolve com alguem autenticado.
protegerPagina().then((logado) => {
  usuario = logado;

  montarBarraUsuario($("barraUsuario"), logado);
  mostrarAtalhoAdmin(logado);

  recuperarDepartamento();
  preencherSelectsDepartamento();
  preencherSelectResponsavel();
  escutarDepartamentos();
  escutarPessoas();
  escutarQuadro();
});
