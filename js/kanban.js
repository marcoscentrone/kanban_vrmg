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

import { db, COLECAO_CARDS, AMBIENTE } from "./firebase-config.js";
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

// As colunas sao fixas e vivem no codigo (nao no Firestore): mudam raramente
// e assim o quadro ja abre desenhado, antes mesmo do primeiro snapshot.
// O campo `coluna` de cada card guarda um destes ids.
const COLUNAS = [
  { id: "backlog",    titulo: "Demanda",    grupo: null    }, // id mantido por compatibilidade com dados ja salvos
  { id: "analise",    titulo: "Análise",    grupo: null    },
  { id: "fazendo",    titulo: "Fazendo",    grupo: null    },
  { id: "aguardando", titulo: "Aguardando", grupo: "Teste" },
  { id: "testando",   titulo: "Testando",   grupo: "Teste" },
  { id: "finalizado", titulo: "Finalizado", grupo: null    }
];

// Ajuste esta lista conforme os departamentos reais da unidade.
const DEPARTAMENTOS = [
  "Suporte",
  "Implantação",
  "Desenvolvimento",
  "Comercial",
  "Financeiro",
  "Administrativo"
];

const PRIORIDADES = ["baixa", "media", "alta"];
const CHAVE_NOME = "kanban-user-name";

// Retencao das tarefas concluidas: uma tarefa fica 30 dias em "Finalizado" e,
// depois disso, qualquer pessoa pode remove-la pelo botao "Limpar concluídas".
// Nada e apagado sozinho - a exclusao e sempre uma acao de alguem.
const COLUNA_FINAL = "finalizado";

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
let filtroDepartamento = "";

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
const nomeInput  = $("userName");
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
  return card.coluna === COLUNA_FINAL && diasRestantes(card) === 0;
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
  const lista = cardsDaColuna(colunaId);
  if (!filtroDepartamento) return lista;
  return lista.filter((c) => (c.departamento || "") === filtroDepartamento);
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

/* --------------------------------------------------------------------------
   6. Render
   -------------------------------------------------------------------------- */

function render() {
  groupsEl.innerHTML = "";

  // Agrupa colunas vizinhas que compartilham o mesmo `grupo` (ex: "Teste").
  const clusters = [];
  const gruposVistos = new Set();

  COLUNAS.forEach((col) => {
    if (col.grupo) {
      if (gruposVistos.has(col.grupo)) return;
      gruposVistos.add(col.grupo);
      clusters.push({ grupo: col.grupo, cols: COLUNAS.filter((c) => c.grupo === col.grupo) });
    } else {
      clusters.push({ grupo: null, cols: [col] });
    }
  });

  clusters.forEach((cluster) => {
    const gDiv = document.createElement("div");
    gDiv.className = "group";
    // Grupo com N colunas ocupa N fatias: base/maximo = N colunas + (N-1) espacos.
    // Assim as colunas de "Teste" ficam do mesmo tamanho das colunas soltas.
    const n = cluster.cols.length;
    if (n > 1) {
      gDiv.style.flex = `${n} 1 calc(${n} * var(--col-min) + ${n - 1} * var(--col-gap))`;
      gDiv.style.maxWidth = `calc(${n} * var(--col-max) + ${n - 1} * var(--col-gap))`;
    }

    const label = document.createElement("div");
    label.className = "group-label" + (cluster.grupo ? " show" : "");
    label.textContent = cluster.grupo || "";
    gDiv.appendChild(label);

    const colsDiv = document.createElement("div");
    colsDiv.className = "group-cols";
    cluster.cols.forEach((col) => colsDiv.appendChild(renderColuna(col)));

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
  if (col.id === COLUNA_FINAL || !card.fimPrevisto) return null;

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

// Bolinha no canto superior direito. A cor percorre o circulo HSL de 120 (verde)
// ate 0 (vermelho), passando por 60 (amarelo) na metade do prazo.
function renderBolinha(card, col) {
  const p = progressoPrazo(card, col);
  if (p === null) return "";

  const hue = Math.round(120 * (1 - p));
  const cor = `hsl(${hue}, 68%, ${p >= 1 ? 45 : 40}%)`;

  const fim = new Date(card.fimPrevisto + "T00:00:00");
  const hoje = new Date(hojeISO() + "T00:00:00");
  const dias = Math.round((fim - hoje) / MS_POR_DIA);

  let texto;
  if (dias < 0) texto = `Atrasada ${-dias} ${dias === -1 ? "dia" : "dias"} (previsto ${formatarDataISO(card.fimPrevisto)})`;
  else if (dias === 0) texto = `Termina hoje (${formatarDataISO(card.fimPrevisto)})`;
  else texto = `Faltam ${dias} ${dias === 1 ? "dia" : "dias"} para ${formatarDataISO(card.fimPrevisto)}`;

  return `<span class="task-dot" style="background:${cor}" title="${escapeHtml(texto)}"></span>`;
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
  if (col.id !== COLUNA_FINAL) return "";

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
  if (col.id !== COLUNA_FINAL) return;

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
  if (colunaDepois === COLUNA_FINAL && colunaAntes !== COLUNA_FINAL) {
    return { finalizadoEm: serverTimestamp() };
  }
  if (colunaAntes === COLUNA_FINAL && colunaDepois !== COLUNA_FINAL) {
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

function preencherSelectsDepartamento() {
  const selModal = $("fDepartamento");

  selModal.innerHTML = '<option value="">— sem departamento —</option>';
  DEPARTAMENTOS.forEach((d) => {
    selModal.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`);
  });

  filtroSel.innerHTML = '<option value="">Todos</option>';
  DEPARTAMENTOS.forEach((d) => {
    filtroSel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`);
  });
}

function abrirModal(colunaId, cardId) {
  editando = { colunaId, cardId };
  const ehEdicao = !!cardId;

  $("modalTitle").textContent = ehEdicao ? "Editar tarefa" : "Nova tarefa";
  $("deleteBtn").style.display = ehEdicao ? "inline" : "none";
  erroModal.textContent = "";

  if (ehEdicao) {
    const card = cardPorId(cardId);
    if (!card) return; // card apagado por outra pessoa enquanto a tela estava aberta
    $("fTitle").value = card.titulo;
    $("fDesc").value = card.descricao || "";
    $("fDepartamento").value = card.departamento || "";
    $("fAssignee").value = card.responsavel || "";
    $("fPriority").value = card.prioridade;
    $("fInicio").value = card.inicioPrevisto || "";
    $("fFim").value = card.fimPrevisto || "";
  } else {
    $("fTitle").value = "";
    $("fDesc").value = "";
    $("fDepartamento").value = filtroDepartamento || "";
    $("fAssignee").value = nomeInput.value.trim();
    $("fPriority").value = "media";
    $("fInicio").value = "";
    $("fFim").value = "";
  }

  overlay.classList.add("show");
  $("fTitle").focus();
}

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

  const inicioPrevisto = $("fInicio").value; // "AAAA-MM-DD" ou ""
  const fimPrevisto = $("fFim").value;
  if (inicioPrevisto && fimPrevisto && fimPrevisto < inicioPrevisto) {
    erroModal.textContent = "O término previsto não pode ser antes do início.";
    $("fFim").focus();
    return;
  }

  const dados = {
    titulo,
    descricao: $("fDesc").value.trim(),
    departamento: $("fDepartamento").value,
    responsavel: $("fAssignee").value.trim(),
    prioridade: $("fPriority").value,
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
        criadoPor: nomeInput.value.trim() || "anônimo"
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
   9. Nome do usuario (local, so deste navegador)
   -------------------------------------------------------------------------- */
// Enquanto nao houver Firebase Authentication, o nome fica no localStorage.
// Ao integrar ao portal, basta trocar isto pelo displayName do usuario logado.

function carregarNome() {
  try {
    const salvo = localStorage.getItem(CHAVE_NOME);
    if (salvo) nomeInput.value = salvo;
  } catch (e) {
    /* localStorage bloqueado - segue sem nome salvo */
  }
}

function salvarNome() {
  try {
    localStorage.setItem(CHAVE_NOME, nomeInput.value.trim());
  } catch (e) {
    /* ignora */
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

nomeInput.addEventListener("change", salvarNome);

filtroSel.addEventListener("change", () => {
  filtroDepartamento = filtroSel.value;
  render();
});

// O contador de dias muda com o tempo, nao com os dados: sem isto uma aba
// deixada aberta mostraria "sai em 3 dias" para sempre.
setInterval(render, 60 * 60 * 1000);

preencherSelectsDepartamento();
carregarNome();
escutarQuadro();
