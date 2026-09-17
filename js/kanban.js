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
  db, COLECAO_CARDS, COLECAO_DEPARTAMENTOS, COLECAO_ACESSOS, AMBIENTE, ADMIN_ABERTO
} from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario, existeAlgumAdmin } from "./auth.js";
import { COLUNAS_PADRAO, lerColunas, colunasDe } from "./colunas.js";
import {
  MAX_SUBTAREFAS, ESTADO_INFO, proximoEstado, lerSubtarefas, lerPadroes,
  gerarIdSubtarefa, subtarefasIniciais, progresso
} from "./subtarefas.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
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

// Retencao das tarefas concluidas: uma tarefa fica 30 dias em "Finalizado" e,
// depois disso, qualquer pessoa pode remove-la pelo botao "Limpar concluídas".
// Nada e apagado sozinho - a exclusao e sempre uma acao de alguem.
// A ultima lista do fluxo e a de conclusao: onde vale a retencao de 30 dias.
function colunaFinal() {
  return COLUNAS.length ? COLUNAS[COLUNAS.length - 1].id : "finalizado";
}

// Janela em que uma tarefa comeca a "esquentar" pela proximidade da data:
// a 14 dias do termino ela sai do verde e caminha para o vermelho.
const JANELA_ALERTA_DIAS = 14;
const DIAS_RETENCAO = 30;
const MS_POR_DIA = 86400000;

/* --------------------------------------------------------------------------
   2. Estado local (espelho do Firestore, alimentado pelo onSnapshot)
   -------------------------------------------------------------------------- */

let cards = [];                                  // [{id, titulo, coluna, ...}]
let editando = { colunaId: null, cardId: null }; // alvo do modal
let arrastando = null;                           // id do card em drag
let filtroDepartamento = "";   // departamento de trabalho (sempre um)
let usuario = null;   // { user, email, permissao } - preenchido no boot
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
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
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

// Datas de projecao sao gravadas como texto "AAAA-MM-DD" (o mesmo formato do
// <input type="date">). Assim nao ha deslocamento de fuso horario e a
// comparacao/ordenacao funciona por simples comparacao de strings.
function hojeISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatarDataISO(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}` + (ano !== String(new Date().getFullYear()) ? `/${ano.slice(2)}` : "");
}

// Soma dias a uma data "AAAA-MM-DD" e devolve no mesmo formato.
function somarDias(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Diferenca em dias entre duas datas "AAAA-MM-DD" (b - a).
function diasEntre(isoA, isoB) {
  return Math.round(
    (new Date(isoB + "T00:00:00") - new Date(isoA + "T00:00:00")) / MS_POR_DIA
  );
}

// O dono e um e-mail. Tarefas criadas antes do login guardaram texto livre
// ("anonimo", um nome digitado) - isso nao identifica ninguem, entao vale como
// "sem dono".
function temDonoReal(card) {
  return !!card && typeof card.criadoPor === "string" && card.criadoPor.includes("@");
}

// Quem pode excluir: o dono da tarefa, um administrador (pode tudo), ou
// qualquer pessoa quando a tarefa nao tem dono registrado - senao as antigas
// ficariam impossiveis de limpar.
function podeExcluir(card) {
  if (!card || !usuario) return false;
  if (usuario.permissao.admin) return true;
  if (!temDonoReal(card)) return true;
  return card.criadoPor === usuario.email;
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

// Dias que ainda faltam para a tarefa poder ser removida (0 = ja liberada,
// null = sem data conhecida, entao nunca expira sozinha).
function diasRestantes(card) {
  const d = finalizadaEm(card);
  if (!d) return null;
  const decorridos = (Date.now() - d.getTime()) / MS_POR_DIA;
  return Math.max(0, Math.ceil(DIAS_RETENCAO - decorridos));
}

function expirada(card) {
  return card.coluna === colunaFinal() && diasRestantes(card) === 0;
}

function cardsExpirados() {
  return cards.filter(expirada);
}

// Cards de uma coluna, sempre na mesma ordem: os mais perto de vencer no topo,
// os folgados abaixo, e os SEM data de termino sempre por ultimo. Nao existe
// ordem manual - a posicao e consequencia do prazo, e se reorganiza sozinha
// quando alguem edita uma data ou o dia vira.
function cardsDaColuna(colunaId) {
  const col = { id: colunaId };
  return cards
    .filter((c) => c.coluna === colunaId)
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

function cardsVisiveis(colunaId) {
  // O quadro trabalha sempre dentro de um departamento, entao o recorte por
  // permissao ja esta garantido pela lista do seletor.
  return cardsDaColuna(colunaId).filter(
    (c) => (c.departamento || "") === filtroDepartamento
  );
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
  // urgencia (prazo de termino). Assim nao e preciso indice composto no Firestore
  onSnapshot(
    cardsRef,
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
          coluna: COLUNAS.some((c) => c.id === dados.coluna) ? dados.coluna : COLUNAS[0].id,
          departamento: dados.departamento || "",
          responsavel: dados.responsavel || "",
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
        .map((d) => (d.data().email || d.id || "").toLowerCase())
        .filter((e) => e.includes("@"))
        .map((e) => ({ nome: nomeDoEmail(e), email: e }));
      montarSugestoes();
    },
    (erro) => {
      // Sem permissao de leitura o campo simplesmente fica sem sugestoes.
      console.warn("[kanban] sem sugestões de responsável:", erro.code || erro);
      montarSugestoes();
    }
  );
}

// So quem esta cadastrado em kanban_acessos pode ser responsavel. A excecao e o
// nome que ja estava gravado na tarefa aberta: mantemos na lista para nao
// impedir a edicao dos outros campos de uma tarefa antiga.
function montarSugestoes(nomeAtual = "") {
  const lista = $("listaPessoas");
  if (!lista) return;

  const vistos = new Map();
  PESSOAS.forEach((p) => vistos.set(p.nome.toLowerCase(), p));

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

  renderBotaoLimpeza(colDiv, col);

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
  const div = document.createElement("div");
  div.className = "task-card p-" + card.prioridade;
  div.draggable = true;
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
        <button class="icon-btn" data-action="left" title="Mover para trás" ${indiceCol === 0 ? "disabled" : ""}>←</button>
        <button class="icon-btn" data-action="edit" title="Editar">✎</button>
        <button class="icon-btn" data-action="right" title="Mover para frente" ${indiceCol === COLUNAS.length - 1 ? "disabled" : ""}>→</button>
      </div>
    </div>
  `;

  div.querySelectorAll(".sub").forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      avancarSubtarefa(card.id, li.dataset.sub);
    });
  });

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

// Quao perto a tarefa esta do termino previsto, de 0 (recem-comecada) a 1
// (no prazo final ou vencida). Retorna null quando nao da para medir.
function progressoPrazo(card, col) {
  // Tarefa concluida nao tem "proximidade do fim" - ela ja acabou.
  if (col.id === colunaFinal() || !card.fimPrevisto) return null;

  const hoje = new Date(hojeISO() + "T00:00:00");
  const fim = new Date(card.fimPrevisto + "T00:00:00");
  if (hoje >= fim) return 1; // venceu hoje ou ja passou

  // (a) Proximidade no calendario: quanto falta para a data, sem olhar o
  //     tamanho do prazo. Vence amanha = quase 1, mesmo que tenha comecado hoje.
  const diasAteFim = (fim - hoje) / MS_POR_DIA;
  const porCalendario = Math.min(1, Math.max(0, 1 - diasAteFim / JANELA_ALERTA_DIAS));

  // (b) Fatia do prazo ja consumida, quando ha inicio previsto. Uma tarefa de
  //     6 meses com 90% do tempo gasto ja merece atencao, ainda que a data
  //     final esteja longe.
  let porPrazo = 0;
  if (card.inicioPrevisto && card.inicioPrevisto < card.fimPrevisto) {
    const ini = new Date(card.inicioPrevisto + "T00:00:00");
    porPrazo = Math.min(1, Math.max(0, (hoje - ini) / (fim - ini)));
  }

  // Vale o pior dos dois criterios: o que estiver mais perto do vermelho.
  return Math.max(porCalendario, porPrazo);
}

// Cor da bolinha de prazo, de 0 (inicio, folgado) a 1 (vencido).
//
// A interpolacao acontece em HSL entre tres ancoras, NUNCA em RGB: misturar
// verde e vermelho no espaco RGB produz marrom, e reduzir saturacao/luminosidade
// no meio do caminho produz oliva e vinho. Aqui a saturacao nunca cai abaixo de
// 71%, entao toda a escala continua viva.
//
//   p = 0.0  ->  #22c55e  verde
//   p = 0.5  ->  #eab308  amarelo
//   p = 1.0  ->  #ef4444  vermelho
// >>> INTENSIDADE DAS CAIXAS DE SUBTAREFA <<<
// 1 = cor cheia (forte)   0.5 = metade   0.25 = bem suave
// So afeta o fundo das subtarefas; a bolinha do card continua solida.
const OPACIDADE_SUBTAREFA = 0.30;

const ANCORAS_PRAZO = [
  { h: 142, s: 71, l: 45 },   // verde
  { h: 45,  s: 93, l: 47 },   // amarelo
  { h: 0,   s: 84, l: 60 }    // vermelho
];

function corDoPrazo(p, opacidade = 1) {
  const t = Math.min(1, Math.max(0, p));

  // Metade do caminho: verde -> amarelo. Depois: amarelo -> vermelho.
  const [de, para, fatia] = t < 0.5
    ? [ANCORAS_PRAZO[0], ANCORAS_PRAZO[1], t / 0.5]
    : [ANCORAS_PRAZO[1], ANCORAS_PRAZO[2], (t - 0.5) / 0.5];

  const entre = (a, b) => a + (b - a) * fatia;
  const h = Math.round(entre(de.h, para.h));
  const sat = Math.round(entre(de.s, para.s));
  const luz = Math.round(entre(de.l, para.l));

  return `hsla(${h}, ${sat}%, ${luz}%, ${opacidade})`;
}

// Bolinha no canto superior direito. A cor percorre o circulo HSL de 120 (verde)
// ate 0 (vermelho), passando por 60 (amarelo) na metade do prazo.
function renderBolinha(card, col) {
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

// Janela de datas de cada subtarefa pendente.
//
// O tempo que ainda resta do card (de hoje ate o termino previsto) e dividido
// igualmente entre as R pendentes, em blocos sequenciais:
//
//   30 dias / 5 etapas -> 6 dias cada
//   1-1: 17/09 a 23/09   1-2: 24/09 a 29/09   1-3: 30/09 a 05/10 ...
//
// Concluir uma etapa antes do prazo nao sobra tempo no vazio: as pendentes
// recalculam e ganham blocos maiores, porque passam a dividir o mesmo resto
// entre menos gente.
function janelasDasSubtarefas(card) {
  const janelas = new Map();
  if (!card.fimPrevisto) return janelas;

  const hoje = hojeISO();
  // Se a tarefa ainda nem comecou, o cronograma parte da data de inicio.
  const base =
    card.inicioPrevisto && card.inicioPrevisto > hoje ? card.inicioPrevisto : hoje;

  const pendentes = (card.subtarefas || []).filter((s) => s.estado !== "feito");
  if (!pendentes.length) return janelas;

  const totalDias = diasEntre(base, card.fimPrevisto);
  if (totalDias < 0) {
    // Prazo do card ja venceu: nao ha bloco a distribuir.
    pendentes.forEach((s) => janelas.set(s.id, { vencido: true }));
    return janelas;
  }

  const passo = totalDias / pendentes.length;
  let inicio = base;

  pendentes.forEach((sub, i) => {
    const fim = somarDias(base, Math.round((i + 1) * passo));
    janelas.set(sub.id, { inicio, fim, vencido: false });
    inicio = somarDias(fim, 1);
  });

  return janelas;
}

// Texto do tooltip. Distingue duas coisas que se confundem facilmente:
//   - o TAMANHO da janela da etapa (quanto tempo ela tem para ser feita)
//   - QUANDO essa janela vence (contado de hoje)
// A 1a etapa comeca hoje, entao para ela as duas informacoes coincidem.
function tituloSubtarefa(sub, janela) {
  const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;

  if (sub.estado === "feito") return "concluída";
  if (!janela) return `${info.rotulo} — clique para mudar`;
  if (janela.vencido) return `${info.rotulo} — prazo do card vencido
Clique para mudar`;

  const hoje = hojeISO();
  const ateOFim = diasEntre(hoje, janela.fim);
  const ateOComeco = diasEntre(hoje, janela.inicio);
  const tamanho = diasEntre(janela.inicio, janela.fim) + 1;

  const prazo = `${formatarDataISO(janela.inicio)} a ${formatarDataISO(janela.fim)}`;
  const dia = (n) => `${n} ${n === 1 ? "dia" : "dias"}`;

  let tempo;
  if (ateOFim < 0) {
    tempo = `atrasada ${dia(-ateOFim)}`;
  } else if (ateOComeco <= 0) {
    // Ja e a vez dela: o que importa e quanto falta para terminar.
    tempo = ateOFim === 0 ? "termina hoje" : `faltam ${dia(ateOFim)} para terminar`;
  } else {
    // Ainda vai comecar: mostra o tamanho da janela e quando ela abre.
    tempo = `${dia(tamanho)} de prazo · começa em ${dia(ateOComeco)}`;
  }

  return `${info.rotulo} · ${prazo}
${tempo}
Clique para mudar`;
}

// Cor de cada subtarefa: ORDEM DE URGENCIA.
//
// Concluidas ficam VERDES para sempre - saem da fila e do rateio.
//
// Entre as R pendentes, a 1a e a que precisa sair agora (mais quente) e a
// ultima e a mais folgada (verde). Esse gradiente e entao deslocado pelo
// quanto o card ja consumiu do proprio prazo:
//
//     urgencia(i) = p + (1 - p) * (1 - i / R)
//
// Consequencias:
//   . card no inicio (p=0)  -> gradiente cheio: 1a quente, ultima verde
//   . card vencido (p=1)    -> todas vermelhas, nao importa a posicao
//   . concluir uma etapa    -> R diminui, as restantes esfriam (mais folga
//                              por etapa)
//   . sobrou 1 etapa e muito prazo -> ela fica verde
function coresDasSubtarefas(card, col) {
  const subs = card.subtarefas || [];
  const cores = new Map();
  if (!subs.length) return cores;

  const p = progressoPrazo(card, col);          // null = sem data de termino
  const pendentes = subs.filter((s) => s.estado !== "feito");
  const total = pendentes.length;

  subs.forEach((s) => {
    if (s.estado === "feito") cores.set(s.id, corDoPrazo(0, OPACIDADE_SUBTAREFA));
  });

  if (p === null) return cores;                 // sem cronograma: pendentes neutras

  pendentes.forEach((s, i) => {
    const posicaoNaFila = 1 - (i + 1) / total;  // 1a = mais alta, ultima = 0
    const urgencia = p + (1 - p) * posicaoNaFila;
    cores.set(s.id, corDoPrazo(urgencia, OPACIDADE_SUBTAREFA));
  });

  return cores;
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
      const dica = tituloSubtarefa(sub, janelas.get(sub.id));
      return `<li class="sub ${sub.estado}${cor ? " colorida" : ""}" data-sub="${escapeHtml(sub.id)}"
                  title="${escapeHtml(dica)}"${estilo}>
        <span class="sub-icone">${info.icone}</span>
        <span class="sub-num">1-${i + 1}</span>
        <span class="sub-nome">${escapeHtml(sub.nome)}</span>
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
  if (!card) return;

  const novas = (card.subtarefas || []).map((s) =>
    s.id === subId ? { ...s, estado: proximoEstado(s.estado) } : s
  );

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      subtarefas: novas,
      atualizadoEm: serverTimestamp()
    });
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

// Selo de retencao, so em "Finalizado": quantos dias faltam para a tarefa
// poder ser removida por qualquer pessoa.
function renderRetencao(card, col) {
  if (col.id !== colunaFinal()) return "";

  const dias = diasRestantes(card);
  if (dias === null) return "";

  if (dias === 0) {
    return `<div class="task-retencao liberada" title="Passaram-se ${DIAS_RETENCAO} dias: qualquer pessoa pode remover">
      <span>🗑</span><span>liberada para exclusão</span>
    </div>`;
  }

  const aviso = dias <= 7 ? " perto" : "";
  return `<div class="task-retencao${aviso}" title="Tarefas concluídas ficam ${DIAS_RETENCAO} dias no quadro">
    <span>⏳</span><span>sai em ${dias} ${dias === 1 ? "dia" : "dias"}</span>
  </div>`;
}

// Botao de limpeza da coluna "Finalizado". Aparece so quando ha tarefas que ja
// passaram dos DIAS_RETENCAO - e qualquer pessoa pode usar.
function renderBotaoLimpeza(colDiv, col) {
  if (col.id !== colunaFinal()) return;

  const expirados = cardsExpirados();
  if (!expirados.length) return;

  const btn = document.createElement("button");
  btn.className = "limpar-btn";
  btn.textContent = `🗑 Limpar ${expirados.length} concluída${expirados.length === 1 ? "" : "s"}`;
  btn.title = `Remove as tarefas que estao ha mais de ${DIAS_RETENCAO} dias em Finalizado`;
  btn.onclick = () => limparExpiradas();
  colDiv.appendChild(btn);
}

async function limparExpiradas() {
  const expirados = cardsExpirados();
  if (!expirados.length) return;

  const qtd = expirados.length;
  const msg =
    qtd === 1
      ? `Remover 1 tarefa concluída há mais de ${DIAS_RETENCAO} dias?`
      : `Remover ${qtd} tarefas concluídas há mais de ${DIAS_RETENCAO} dias?`;
  if (!confirm(`${msg}

Isso vale para toda a equipe e não tem desfazer.`)) return;

  try {
    // writeBatch aceita ate 500 operacoes; fatiamos por seguranca.
    for (let i = 0; i < expirados.length; i += 400) {
      const lote = writeBatch(db);
      expirados.slice(i, i + 400).forEach((c) => lote.delete(doc(db, COLECAO_CARDS, c.id)));
      await lote.commit();
    }
    setStatus(`${qtd} ${qtd === 1 ? "tarefa removida" : "tarefas removidas"} do quadro.`);
  } catch (e) {
    console.error("[kanban] falha ao limpar concluidas:", e);
    setStatus("Não foi possível remover as tarefas concluídas.", true);
  }
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

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      coluna: colunaDestino,
      atualizadoEm: serverTimestamp(),
      ...carimboFinalizacao(card.coluna, colunaDestino)
    });
  } catch (e) {
    console.error("[kanban] falha ao mover card:", e);
    setStatus("Não foi possível mover a tarefa. Tente de novo.", true);
  }
}

async function moverColunaVizinha(cardId, direcao) {
  const card = cardPorId(cardId);
  if (!card) return;

  const idx = COLUNAS.findIndex((c) => c.id === card.coluna);
  const destino = COLUNAS[idx + direcao];
  if (!destino) return;

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      coluna: destino.id,
      atualizadoEm: serverTimestamp(),
      ...carimboFinalizacao(card.coluna, destino.id)
    });
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

    // So o dono da tarefa pode excluir.
    const dono = podeExcluir(card);
    $("deleteBtn").style.display = dono ? "inline" : "none";
    $("hintDono").textContent = !dono
      ? "Só quem criou a tarefa — ou um administrador — pode excluí-la."
      : usuario.permissao.admin && temDonoReal(card) && card.criadoPor !== usuario.email
        ? "Você é administrador, então pode excluir esta tarefa."
        : "Você pode excluir esta tarefa.";
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
    $("deleteBtn").style.display = "none";
    $("hintDono").textContent = "Quem cria a tarefa é o dono e pode excluí-la depois.";
  }

  overlay.classList.add("show");
  $("fTitle").focus();
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

function renderSubsModal() {
  const box = $("subsModal");
  const form = $("addSubBox");

  $("contaSubsModal").textContent = `${subsRascunho.length}/${MAX_SUBTAREFAS}`;
  form.style.display = subsRascunho.length >= MAX_SUBTAREFAS ? "none" : "flex";

  if (!subsRascunho.length) {
    box.innerHTML = '<p class="subs-vazio">Nenhuma etapa. Adicione abaixo, se precisar.</p>';
    return;
  }

  box.innerHTML = "";
  subsRascunho.forEach((sub, i) => {
    const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;
    const linha = document.createElement("div");
    linha.className = "sub-linha " + sub.estado;
    linha.innerHTML = `
      <button type="button" class="sub-estado" title="${info.rotulo}">${info.icone}</button>
      <span class="sub-num">1-${i + 1}</span>
      <input class="sub-input" maxlength="40" value="${escapeHtml(sub.nome)}">
      <button type="button" class="sub-remover" title="Remover">&times;</button>
    `;
    linha.querySelector(".sub-estado").onclick = () => {
      subsRascunho[i].estado = proximoEstado(subsRascunho[i].estado);
      renderSubsModal();
    };
    linha.querySelector(".sub-input").oninput = (e) => {
      subsRascunho[i].nome = e.target.value;
    };
    linha.querySelector(".sub-remover").onclick = () => {
      subsRascunho.splice(i, 1);
      renderSubsModal();
    };
    box.appendChild(linha);
  });
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
      await updateDoc(doc(db, COLECAO_CARDS, editando.cardId), dados);
    } else {
      await addDoc(cardsRef, {
        ...dados,
        coluna: editando.colunaId,
        criadoEm: serverTimestamp(),
        criadoPor: usuario ? usuario.email : ""
      });
    }
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao salvar:", e);
    erroModal.textContent = "Erro ao salvar no Firestore. Verifique a conexão.";
  } finally {
    btn.disabled = false;
  }
}

async function excluirTarefa() {
  const card = cardPorId(editando.cardId);
  if (!card) { fecharModal(); return; }

  if (!podeExcluir(card)) {
    erroModal.textContent =
      `Só ${nomeDoEmail(card.criadoPor)} (dono) ou um administrador pode excluir esta tarefa.`;
    return;
  }

  if (!confirm(`Excluir a tarefa "${card.titulo}"? Isso vale para toda a equipe.`)) return;

  try {
    await deleteDoc(doc(db, COLECAO_CARDS, editando.cardId));
    fecharModal();
  } catch (e) {
    console.error("[kanban] falha ao excluir:", e);
    erroModal.textContent = "Erro ao excluir. Tente novamente.";
  }
}

/* --------------------------------------------------------------------------
   10. Ligacoes de eventos + boot
   -------------------------------------------------------------------------- */

$("saveBtn").onclick = salvarTarefa;
$("deleteBtn").onclick = excluirTarefa;
$("cancelBtn").onclick = fecharModal;

overlay.addEventListener("click", (e) => { if (e.target === overlay) fecharModal(); });

document.addEventListener("keydown", (e) => {
  if (!overlay.classList.contains("show")) return;
  if (e.key === "Escape") fecharModal();
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

filtroSel.addEventListener("change", () => {
  filtroDepartamento = filtroSel.value;
  aplicarFluxoDoDepartamento();
  lembrarDepartamento();
  render();
});

// O contador de dias muda com o tempo, nao com os dados: sem isto uma aba
// deixada aberta mostraria "sai em 3 dias" para sempre.
setInterval(render, 60 * 60 * 1000);

// O atalho para a area administrativa aparece para quem e administrador e
// tambem enquanto NENHUM administrador existir - senao o primeiro acesso nao
// teria por onde entrar para se cadastrar.
async function mostrarAtalhoAdmin(logado) {
  const link = $("linkAdmin");
  if (!link) return;

  if (logado.permissao.admin) {
    link.style.display = "inline-flex";
    return;
  }

  // Modo aberto: todo mundo ve o atalho, para que o primeiro administrador
  // possa ser cadastrado. Desligar em firebase-config.js depois disso.
  if (ADMIN_ABERTO) {
    link.style.display = "inline-flex";
    link.classList.add("primeiro-acesso");
    link.title = "Área administrativa (modo aberto — cadastre o primeiro administrador)";
    return;
  }

  const temAdmin = await existeAlgumAdmin();

  if (temAdmin === "erro") {
    // Nao deu nem para consultar: quase sempre as regras do Firestore ainda nao
    // liberam kanban_acessos. Melhor dizer isso do que sumir com o botao.
    setStatus(
      "Configurações indisponíveis: o Firestore recusou a leitura de " +
        "kanban_acessos. Publique o conteúdo de firestore.rules no console.",
      true
    );
    return;
  }

  if (temAdmin === false) {
    link.style.display = "inline-flex";
    link.classList.add("primeiro-acesso");
    link.title = "Nenhum administrador cadastrado — clique para configurar";
  }
}

// Nada roda antes do login: protegerPagina() so resolve com alguem autenticado.
protegerPagina().then((logado) => {
  usuario = logado;

  montarBarraUsuario($("barraUsuario"), logado);
  mostrarAtalhoAdmin(logado);

  recuperarDepartamento();
  preencherSelectsDepartamento();
  escutarDepartamentos();
  escutarPessoas();
  escutarQuadro();
});
