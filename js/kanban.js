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

// Espacamento entre cards na ordenacao. Ao soltar um card entre outros dois,
// a nova ordem e a media das duas vizinhas - assim so 1 documento e gravado
// por movimento, em vez de reescrever a coluna inteira.
const PASSO_ORDEM = 1000;
const GAP_MINIMO = 0.0005; // abaixo disso, renormaliza a coluna

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

// Cards de uma coluna, ja na ordem de exibicao.
function cardsDaColuna(colunaId) {
  return cards
    .filter((c) => c.coluna === colunaId)
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
}

function cardsVisiveis(colunaId) {
  const lista = cardsDaColuna(colunaId);
  if (!filtroDepartamento) return lista;
  return lista.filter((c) => (c.departamento || "") === filtroDepartamento);
}

function ordemNoFim(colunaId) {
  const lista = cardsDaColuna(colunaId);
  if (!lista.length) return PASSO_ORDEM;
  return (lista[lista.length - 1].ordem ?? 0) + PASSO_ORDEM;
}

/* --------------------------------------------------------------------------
   5. Leitura em tempo real (onSnapshot)
   -------------------------------------------------------------------------- */

function escutarQuadro() {
  setStatus("Carregando quadro…");
  setLive(false, "conectando…");

  // Sem orderBy no servidor de proposito: a ordenacao e feita no cliente por
  // `ordem`. Assim nenhum card some caso um documento antigo nao tenha o campo,
  // e nao e preciso criar indice composto no Firestore.
  onSnapshot(
    cardsRef,
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
          ordem: typeof dados.ordem === "number" ? dados.ordem : 0,
          inicioPrevisto: typeof dados.inicioPrevisto === "string" ? dados.inicioPrevisto : "",
          fimPrevisto: typeof dados.fimPrevisto === "string" ? dados.fimPrevisto : "",
          criadoEm: dados.criadoEm || null,
          atualizadoEm: dados.atualizadoEm || null
        };
      });

      const origem = snap.metadata.hasPendingWrites ? "salvando…" : "ao vivo";
      setLive(true, origem);

      const total = cards.length;
      setStatus(
        `${total} ${total === 1 ? "tarefa" : "tarefas"} no quadro — atualização automática ativa` +
          (AMBIENTE === "teste" ? " · ambiente de teste (projeto kanbanvr)" : "")
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
    `<span>${escapeHtml(col.titulo)}</span>` +
    `<span class="col-count">${visiveis.length}</span>`;
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

  const addBtn = document.createElement("button");
  addBtn.className = "add-card-btn";
  addBtn.textContent = "+ adicionar tarefa";
  addBtn.onclick = () => abrirModal(col.id, null);
  colDiv.appendChild(addBtn);

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
    await soltarCard(cardId, col.id, list, e.clientY);
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
    <div class="task-title">${escapeHtml(card.titulo)}</div>
    ${card.descricao ? `<div class="task-desc">${escapeHtml(card.descricao)}</div>` : ""}
    ${card.departamento
      ? `<div class="task-tags"><span class="tag-dept">${escapeHtml(card.departamento)}</span></div>`
      : ""}
    ${renderDatas(card, col)}
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

/* --------------------------------------------------------------------------
   7. Movimentacao (drag & drop e setas)
   -------------------------------------------------------------------------- */

// Descobre entre quais cards visiveis o item foi solto, olhando a posicao Y.
function vizinhosNoDrop(listEl, y, idArrastado) {
  const els = Array.from(listEl.querySelectorAll(".task-card")).filter(
    (el) => el.dataset.id !== idArrastado
  );

  let idxProximo = els.length;
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { idxProximo = i; break; }
  }

  return {
    anteriorId: idxProximo > 0 ? els[idxProximo - 1].dataset.id : null,
    proximoId: idxProximo < els.length ? els[idxProximo].dataset.id : null
  };
}

function ordemEntre(anteriorId, proximoId) {
  const ant  = anteriorId ? cardPorId(anteriorId)?.ordem ?? null : null;
  const prox = proximoId  ? cardPorId(proximoId)?.ordem  ?? null : null;

  if (ant == null && prox == null) return PASSO_ORDEM;
  if (ant == null) return prox - PASSO_ORDEM;
  if (prox == null) return ant + PASSO_ORDEM;
  return (ant + prox) / 2;
}

// Depois de muitas insercoes no mesmo ponto, o espaco entre duas ordens pode
// ficar pequeno demais para a precisao de ponto flutuante. Quando isso
// acontece, reescrevemos a coluna inteira com espacamento limpo (1 batch).
async function renormalizarColuna(colunaId) {
  const lista = cardsDaColuna(colunaId);
  if (!lista.length) return;

  const batch = writeBatch(db);
  lista.forEach((c, i) => {
    const novaOrdem = (i + 1) * PASSO_ORDEM;
    batch.update(doc(db, COLECAO_CARDS, c.id), { ordem: novaOrdem });
    c.ordem = novaOrdem; // espelha no estado local para o calculo seguinte
  });
  await batch.commit();
}

async function soltarCard(cardId, colunaDestino, listEl, clientY) {
  const card = cardPorId(cardId);
  if (!card) return;

  const { anteriorId, proximoId } = vizinhosNoDrop(listEl, clientY, cardId);

  // Sem mudanca real? Nao grava nada.
  const mesmaColuna = card.coluna === colunaDestino;
  const listaAtual = cardsDaColuna(colunaDestino).filter((c) => c.id !== cardId);
  const posAtual = cardsDaColuna(colunaDestino).findIndex((c) => c.id === cardId);
  if (mesmaColuna) {
    const idxDestino = proximoId
      ? listaAtual.findIndex((c) => c.id === proximoId)
      : listaAtual.length;
    if (posAtual === idxDestino) return;
  }

  const ant  = anteriorId ? cardPorId(anteriorId) : null;
  const prox = proximoId  ? cardPorId(proximoId)  : null;

  if (ant && prox && Math.abs((prox.ordem ?? 0) - (ant.ordem ?? 0)) < GAP_MINIMO) {
    try {
      await renormalizarColuna(colunaDestino);
    } catch (e) {
      console.error("[kanban] falha ao renormalizar ordem:", e);
    }
  }

  const novaOrdem = ordemEntre(anteriorId, proximoId);

  try {
    await updateDoc(doc(db, COLECAO_CARDS, cardId), {
      coluna: colunaDestino,
      ordem: novaOrdem,
      atualizadoEm: serverTimestamp()
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
      ordem: ordemNoFim(destino.id),
      atualizadoEm: serverTimestamp()
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
        ordem: ordemNoFim(editando.colunaId),
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

preencherSelectsDepartamento();
carregarNome();
escutarQuadro();
