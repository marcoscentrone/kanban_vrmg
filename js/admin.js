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

import {
  db, COLECAO_CARDS, COLECAO_DEPARTAMENTOS, COLECAO_ACESSOS, ADMIN_ABERTO
} from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario, ajustarSubmenu } from "./auth.js";
import {
  MAX_COLUNAS, COLUNAS_PADRAO, lerColunas, colunasDe, gerarIdColuna
} from "./colunas.js";
import { MAX_SUBTAREFAS, lerPadroes } from "./subtarefas.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* -------------------------------------------------------------------------- */
/* Estado                                                                     */
/* -------------------------------------------------------------------------- */

let departamentos = [];   // [{id, nome}]
let acessos = [];         // [{id, email, departamentos:[nomes]}]
let cards = [];           // so para saber quantas tarefas usam cada departamento

let editandoDepartamento = null; // id
let editandoAcesso = null;       // id (= e-mail)
let permissaoAtual = null;       // permissao de quem abriu a pagina (admin/supervisor)

const refDepartamentos = collection(db, COLECAO_DEPARTAMENTOS);
const refAcessos = collection(db, COLECAO_ACESSOS);
const refCards = collection(db, COLECAO_CARDS);

const $ = (id) => document.getElementById(id);

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                 */
/* -------------------------------------------------------------------------- */

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

// Departamentos sao gravados em CAIXA ALTA e sem acentos: evita duplicatas do
// tipo "Implantacao" / "IMPLANTAÇÃO" / "implantação" apontando para a mesma
// coisa, ja que as tarefas guardam o NOME como texto.
function normalizarDepartamento(v) {
  return (v || "")
    .normalize("NFD")                      // separa a letra do acento
    .replace(/\p{Diacritic}/gu, "")      // remove os acentos (C-cedilha vira C)
    .toUpperCase()
    .replace(/[^A-Z0-9 .\-\/]/g, "")       // so ASCII simples
    .replace(/\s+/g, " ")                  // espacos repetidos viram um
    .trimStart();                          // trim() so no envio, para poder digitar espaco
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
      .map((d) => ({
        id: d.id,
        nome: (d.data().nome || "").trim(),
        colunas: lerColunas(d.data()),
        subtarefasPadrao: lerPadroes(d.data())
      }))
      .filter((d) => d.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    marcarConexao(snap);
    renderDepartamentos();
    renderCheckboxes();
    renderAcessos(); // as tags de acesso dependem dos nomes
    renderSelectColunas();
    renderColunas();
    renderSubs();
  }, erroDe("departamentos"));

  onSnapshot(refAcessos, opcoes, (snap) => {
    acessos = snap.docs
      .map((d) => ({
        id: d.id,
        email: d.data().email || d.id,
        departamentos: Array.isArray(d.data().departamentos) ? d.data().departamentos : [],
        admin: d.data().admin === true,
        supervisor: d.data().supervisor === true
      }))
      .sort((a, b) => a.email.localeCompare(b.email, "pt-BR"));

    marcarConexao(snap);
    renderAcessos();
  }, erroDe("acessos"));

  // Somente leitura: serve para avisar quantas tarefas usam um departamento
  // antes de exclui-lo ou renomea-lo.
  onSnapshot(refCards, (snap) => {
    cards = snap.docs.map((d) => ({
      id: d.id,
      departamento: d.data().departamento || "",
      coluna: d.data().coluna || ""
    }));
    renderDepartamentos();
    renderColunas();
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

    // permission-denied nao e queda de conexao: e regra do Firestore barrando.
    // Dizer "offline" aqui manda a pessoa procurar problema no lugar errado.
    if (erro.code === "permission-denied") {
      setLive(false, "sem permissão");
      setStatus(
        "O Firestore está recusando o acesso a " + qual + ". As regras publicadas " +
          "ainda não incluem esta coleção — publique o conteúdo de firestore.rules " +
          "em Firebase Console → Firestore Database → Regras → Publicar.",
        true
      );
      return;
    }

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

// Converte na hora, para a pessoa ver exatamente o que sera gravado.
$("novoDepartamento").addEventListener("input", (e) => {
  const pos = e.target.selectionStart;
  const antes = e.target.value;
  const depois = normalizarDepartamento(antes);
  if (antes !== depois) {
    e.target.value = depois;
    // mantem o cursor no lugar quando nada foi removido, so transformado
    const delta = antes.length - depois.length;
    e.target.setSelectionRange(Math.max(0, pos - delta), Math.max(0, pos - delta));
  }
});

$("formDepartamento").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nome = normalizarDepartamento($("novoDepartamento").value).trim();
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
    $("erroDepartamento").textContent =
      err.code === "permission-denied"
        ? "O Firestore recusou a gravação. Publique as regras de firestore.rules no console."
        : "Erro ao salvar. Verifique a conexão.";
  }
});

// Renomear propaga para as tarefas e os acessos, porque ambos guardam o NOME.
async function renomearDepartamento(dep) {
  const novo = prompt(
    `Renomear "${dep.nome}" para:
(sempre em CAIXA ALTA, sem acentos)`,
    dep.nome
  );
  if (novo === null) return;

  const nome = normalizarDepartamento(novo).trim();
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

/* -------------------------------------------------------------------------- */
/* Reordenar arrastando                                                       */
/* -------------------------------------------------------------------------- */

let arrastandoIndice = null;

// Liga o arrasta-e-solta num item de lista. `aoSoltar(de, para)` recebe os dois
// indices e grava a nova ordem. As setas continuam funcionando - sao o caminho
// acessivel por teclado e o unico que funciona no celular.
function ligarArrasto(li, indice, aoSoltar) {
  li.draggable = true;
  li.dataset.indice = indice;

  li.addEventListener("dragstart", (e) => {
    // Arrastar a partir dos botoes de acao nao deve mover a linha.
    if (e.target.closest(".item-acoes")) { e.preventDefault(); return; }
    arrastandoIndice = indice;
    li.classList.add("arrastando");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(indice));
  });

  li.addEventListener("dragend", () => {
    arrastandoIndice = null;
    li.classList.remove("arrastando");
    li.parentElement.querySelectorAll(".item").forEach((x) =>
      x.classList.remove("solta-acima", "solta-abaixo")
    );
  });

  li.addEventListener("dragover", (e) => {
    if (arrastandoIndice === null || arrastandoIndice === indice) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Metade de cima = entra antes; metade de baixo = entra depois.
    const r = li.getBoundingClientRect();
    const antes = e.clientY < r.top + r.height / 2;
    li.classList.toggle("solta-acima", antes);
    li.classList.toggle("solta-abaixo", !antes);
  });

  li.addEventListener("dragleave", () => {
    li.classList.remove("solta-acima", "solta-abaixo");
  });

  li.addEventListener("drop", async (e) => {
    e.preventDefault();
    const de = arrastandoIndice;
    li.classList.remove("solta-acima", "solta-abaixo");
    if (de === null || de === indice) return;

    const r = li.getBoundingClientRect();
    const antes = e.clientY < r.top + r.height / 2;

    // Ao tirar o item de cima da lista, tudo abaixo sobe uma posicao - por isso
    // o destino desconta 1 quando o item vinha de antes do alvo.
    let destino = antes ? indice : indice + 1;
    if (de < destino) destino -= 1;
    if (destino === de) return;

    arrastandoIndice = null;
    await aoSoltar(de, destino);
  });
}

// Move um item de posicao dentro de um array (copia).
function reordenar(lista, de, para) {
  const copia = [...lista];
  const [item] = copia.splice(de, 1);
  copia.splice(para, 0, item);
  return copia;
}

/* ========================================================================== */
/* 1b. Listas (colunas) de cada departamento                                  */
/* ========================================================================== */

let depSelecionado = "";   // id do departamento escolhido no painel de listas

function depAtual() {
  return departamentos.find((d) => d.id === depSelecionado) || null;
}

// Admin ve todos os departamentos; supervisor so os que supervisiona.
function departamentosVisiveis() {
  if (permissaoAtual && permissaoAtual.supervisor && !permissaoAtual.admin) {
    const meus = permissaoAtual.departamentos || [];
    return departamentos.filter((d) => meus.includes(d.nome));
  }
  return departamentos;
}

function renderSelectColunas() {
  const sel = $("depColunas");
  const anterior = sel.value;
  const lista = departamentosVisiveis();

  sel.innerHTML = '<option value="">- escolha um departamento -</option>' +
    lista
      .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.nome)}</option>`)
      .join("");

  // mantem a selecao entre atualizacoes em tempo real
  if (lista.some((d) => d.id === anterior)) sel.value = anterior;
  else if (lista.some((d) => d.id === depSelecionado)) sel.value = depSelecionado;
  depSelecionado = sel.value;
}

function renderColunas() {
  const ul = $("listaColunas");
  const form = $("formColuna");
  const dep = depAtual();

  ul.innerHTML = "";
  $("erroColuna").textContent = "";

  if (!dep) {
    $("contaColunas").textContent = "0";
    form.style.display = "none";
    $("usarPadrao").style.display = "none";
    ul.innerHTML = '<li class="lista-vazia">Escolha um departamento para ver e editar as listas dele.</li>';
    return;
  }

  const proprias = dep.colunas || [];
  const mostrar = colunasDe(dep);          // as dele, ou o padrao
  const usandoPadrao = proprias.length === 0;

  $("contaColunas").textContent = `${mostrar.length}/${MAX_COLUNAS}`;
  form.style.display = mostrar.length >= MAX_COLUNAS ? "none" : "flex";
  $("usarPadrao").style.display = usandoPadrao ? "inline-block" : "none";

  if (usandoPadrao) {
    ul.innerHTML =
      '<li class="lista-vazia">Sem listas proprias: este departamento usa o fluxo padrao abaixo. ' +
      'Adicionar uma lista, ou clicar em "Usar fluxo padrao", cria uma copia editavel.</li>';
  }

  mostrar.forEach((col, i) => {
    const ehUltima = i === mostrar.length - 1;
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <span class="ordem">${i + 1}</span>
      <div class="item-corpo">
        <div class="item-nome">${escapeHtml(col.nome)}${ehUltima ? '<span class="final">conclusao</span>' : ""}</div>
        <div class="item-sub">${tarefasNaColuna(dep.nome, col.id)} tarefa(s) nesta lista</div>
      </div>
      <div class="item-acoes">
        <button data-acao="subir" title="Mover para a esquerda" ${i === 0 ? "disabled" : ""}>&#8593;</button>
        <button data-acao="descer" title="Mover para a direita" ${ehUltima ? "disabled" : ""}>&#8595;</button>
        <button data-acao="editar" title="Renomear">&#9998;</button>
        <button data-acao="excluir" class="excluir" title="Excluir" ${mostrar.length <= 1 ? "disabled" : ""}>&#128465;</button>
      </div>
    `;
    li.querySelector('[data-acao="subir"]').onclick = () => moverColuna(i, -1);
    li.querySelector('[data-acao="descer"]').onclick = () => moverColuna(i, 1);
    li.querySelector('[data-acao="editar"]').onclick = () => renomearColuna(i);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirColuna(i);

    ligarArrasto(li, i, async (de, para) => {
      await salvarColunas(reordenar(colunasEditaveis(), de, para));
    });

    ul.appendChild(li);
  });
}

function tarefasNaColuna(nomeDep, colId) {
  return cards.filter((c) => c.departamento === nomeDep && c.coluna === colId).length;
}

// Grava o array inteiro. Como sao no maximo 6 itens, reescrever tudo e mais
// simples e seguro do que atualizar posicoes individuais.
async function salvarColunas(novas) {
  const dep = depAtual();
  if (!dep) return;
  try {
    await updateDoc(doc(db, COLECAO_DEPARTAMENTOS, dep.id), {
      colunas: novas,
      atualizadoEm: serverTimestamp()
    });
    setStatus(`Listas de "${dep.nome}" atualizadas.`);
  } catch (err) {
    console.error("[admin] falha ao salvar listas:", err);
    $("erroColuna").textContent =
      err.code === "permission-denied"
        ? "O Firestore recusou a gravacao. Publique as regras de firestore.rules."
        : "Erro ao salvar as listas.";
  }
}

// Base para editar: as proprias, ou uma copia do padrao (primeira edicao).
function colunasEditaveis() {
  const dep = depAtual();
  if (!dep) return [];
  const base = dep.colunas && dep.colunas.length ? dep.colunas : COLUNAS_PADRAO;
  return base.map((c) => ({ ...c }));
}

$("depColunas").addEventListener("change", (e) => {
  depSelecionado = e.target.value;
  renderColunas();
  renderSubs();
});

$("usarPadrao").addEventListener("click", () => salvarColunas(colunasEditaveis()));

$("formColuna").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("erroColuna").textContent = "";

  const nome = $("novaColuna").value.trim();
  if (!nome) return;

  const atuais = colunasEditaveis();
  if (atuais.length >= MAX_COLUNAS) {
    $("erroColuna").textContent = `Maximo de ${MAX_COLUNAS} listas por departamento.`;
    return;
  }
  if (atuais.some((c) => c.nome.toLowerCase() === nome.toLowerCase())) {
    $("erroColuna").textContent = "Ja existe uma lista com esse nome.";
    return;
  }

  atuais.push({ id: gerarIdColuna(nome, atuais.map((c) => c.id)), nome });
  await salvarColunas(atuais);
  $("novaColuna").value = "";
});

async function moverColuna(indice, direcao) {
  const atuais = colunasEditaveis();
  const destino = indice + direcao;
  if (destino < 0 || destino >= atuais.length) return;
  [atuais[indice], atuais[destino]] = [atuais[destino], atuais[indice]];
  await salvarColunas(atuais);
}

async function renomearColuna(indice) {
  const atuais = colunasEditaveis();
  const atual = atuais[indice];
  const novo = prompt(`Renomear a lista "${atual.nome}" para:`, atual.nome);
  if (novo === null) return;

  const nome = novo.trim();
  if (!nome || nome === atual.nome) return;
  if (atuais.some((c, i) => i !== indice && c.nome.toLowerCase() === nome.toLowerCase())) {
    $("erroColuna").textContent = "Ja existe uma lista com esse nome.";
    return;
  }

  // O id nao muda: as tarefas continuam onde estao.
  atuais[indice] = { ...atual, nome };
  await salvarColunas(atuais);
}

async function excluirColuna(indice) {
  const dep = depAtual();
  const atuais = colunasEditaveis();
  const alvo = atuais[indice];

  const usos = tarefasNaColuna(dep.nome, alvo.id);
  if (usos > 0) {
    $("erroColuna").textContent =
      `"${alvo.nome}" tem ${usos} tarefa(s). Mova essas tarefas antes de excluir a lista.`;
    return;
  }
  if (atuais.length <= 1) return;
  if (!confirm(`Excluir a lista "${alvo.nome}" de ${dep.nome}?`)) return;

  atuais.splice(indice, 1);
  await salvarColunas(atuais);
}

/* ========================================================================== */
/* 1c. Subtarefas padrao do departamento                                      */
/* ========================================================================== */

function renderSubs() {
  const ul = $("listaSubs");
  const form = $("formSub");
  const dep = depAtual();

  ul.innerHTML = "";
  $("erroSub").textContent = "";

  if (!dep) {
    $("contaSubs").textContent = "0";
    form.style.display = "none";
    ul.innerHTML = '<li class="lista-vazia">Escolha um departamento acima.</li>';
    return;
  }

  const subs = dep.subtarefasPadrao || [];
  $("contaSubs").textContent = `${subs.length}/${MAX_SUBTAREFAS}`;
  form.style.display = subs.length >= MAX_SUBTAREFAS ? "none" : "flex";

  if (!subs.length) {
    ul.innerHTML =
      '<li class="lista-vazia">Nenhuma etapa padrao. As tarefas deste departamento ' +
      'nascem sem subtarefas - quem criar pode adicionar na propria tarefa.</li>';
    return;
  }

  subs.forEach((nome, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <span class="ordem">1-${i + 1}</span>
      <div class="item-corpo">
        <div class="item-nome">${escapeHtml(nome)}</div>
      </div>
      <div class="item-acoes">
        <button data-acao="subir" title="Subir" ${i === 0 ? "disabled" : ""}>&#8593;</button>
        <button data-acao="descer" title="Descer" ${i === subs.length - 1 ? "disabled" : ""}>&#8595;</button>
        <button data-acao="editar" title="Renomear">&#9998;</button>
        <button data-acao="excluir" class="excluir" title="Excluir">&#128465;</button>
      </div>
    `;
    li.querySelector('[data-acao="subir"]').onclick = () => moverSub(i, -1);
    li.querySelector('[data-acao="descer"]').onclick = () => moverSub(i, 1);
    li.querySelector('[data-acao="editar"]').onclick = () => renomearSub(i);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirSub(i);

    ligarArrasto(li, i, async (de, para) => {
      await salvarSubs(reordenar(subsEditaveis(), de, para));
    });

    ul.appendChild(li);
  });
}

async function salvarSubs(novas) {
  const dep = depAtual();
  if (!dep) return;
  try {
    await updateDoc(doc(db, COLECAO_DEPARTAMENTOS, dep.id), {
      subtarefasPadrao: novas,
      atualizadoEm: serverTimestamp()
    });
    setStatus(`Subtarefas padrao de "${dep.nome}" atualizadas.`);
  } catch (err) {
    console.error("[admin] falha ao salvar subtarefas:", err);
    $("erroSub").textContent =
      err.code === "permission-denied"
        ? "O Firestore recusou a gravacao. Publique as regras de firestore.rules."
        : "Erro ao salvar as subtarefas.";
  }
}

function subsEditaveis() {
  const dep = depAtual();
  return dep ? [...(dep.subtarefasPadrao || [])] : [];
}

$("formSub").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("erroSub").textContent = "";

  const nome = $("novaSub").value.trim();
  if (!nome) return;

  const atuais = subsEditaveis();
  if (atuais.length >= MAX_SUBTAREFAS) {
    $("erroSub").textContent = `Maximo de ${MAX_SUBTAREFAS} subtarefas por tarefa.`;
    return;
  }
  if (atuais.some((n) => n.toLowerCase() === nome.toLowerCase())) {
    $("erroSub").textContent = "Ja existe uma etapa com esse nome.";
    return;
  }

  atuais.push(nome);
  await salvarSubs(atuais);
  $("novaSub").value = "";
});

async function moverSub(indice, direcao) {
  const atuais = subsEditaveis();
  const destino = indice + direcao;
  if (destino < 0 || destino >= atuais.length) return;
  [atuais[indice], atuais[destino]] = [atuais[destino], atuais[indice]];
  await salvarSubs(atuais);
}

async function renomearSub(indice) {
  const atuais = subsEditaveis();
  const atual = atuais[indice];
  const novo = prompt(`Renomear a etapa "${atual}" para:`, atual);
  if (novo === null) return;

  const nome = novo.trim();
  if (!nome || nome === atual) return;
  if (atuais.some((n, i) => i !== indice && n.toLowerCase() === nome.toLowerCase())) {
    $("erroSub").textContent = "Ja existe uma etapa com esse nome.";
    return;
  }

  atuais[indice] = nome;
  await salvarSubs(atuais);
}

async function excluirSub(indice) {
  const atuais = subsEditaveis();
  const alvo = atuais[indice];
  if (!confirm(`Remover a etapa padrao "${alvo}"?\n\nAs tarefas que ja existem nao sao alteradas.`)) return;
  atuais.splice(indice, 1);
  await salvarSubs(atuais);
}

/* ========================================================================== */
/* 2. CRUD de Acessos (e-mail -> departamentos)                               */
/* ========================================================================== */

function renderCheckboxes(marcados = []) {
  const box = $("checkboxesDepartamentos");
  box.innerHTML = "";

  // Supervisor so pode vincular pessoas aos departamentos que ele supervisiona.
  const lista = departamentosVisiveis();
  if (!lista.length) {
    box.innerHTML = '<span class="vazio">Cadastre um departamento primeiro.</span>';
    return;
  }

  lista.forEach((dep) => {
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
  // Supervisor so enxerga/gerencia os membros comuns dos departamentos dele.
  const lista = souSupervisorPuro() ? acessos.filter(acessoGerenciavelPorSup) : acessos;
  $("contaAcessos").textContent = lista.length;
  ul.innerHTML = "";

  if (!lista.length) {
    ul.innerHTML = '<li class="lista-vazia">Nenhum e-mail cadastrado ainda.</li>';
    return;
  }

  lista.forEach((ac) => {
    const li = document.createElement("li");
    li.className = "item" + (editandoAcesso === ac.id ? " editando" : "");

    const tags = ac.departamentos.length
      ? `<div class="item-tags">${ac.departamentos
          .map((n) => `<span>${escapeHtml(n)}</span>`)
          .join("")}</div>`
      : `<div class="item-sub"><span class="nenhum">sem restrição — vê todas as tarefas</span></div>`;

    li.innerHTML = `
      <div class="item-corpo">
        <div class="item-nome">${escapeHtml(ac.email)}${ac.admin ? ' <span class="tag-admin">admin</span>' : ""}${ac.supervisor && !ac.admin ? ' <span class="tag-sup">supervisor</span>' : ""}</div>
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
  if (souSupervisorPuro() && !acessoGerenciavelPorSup(ac)) return;
  editandoAcesso = ac.id;
  $("novoEmail").value = ac.email;
  $("novoEmail").disabled = true; // o e-mail e a chave do documento
  $("ehAdmin").checked = !!ac.admin;
  $("ehSupervisor").checked = !!ac.supervisor;
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
  $("ehSupervisor").checked = false;
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
  // Um supervisor nunca define papel: todo mundo que ele cadastra e membro comum.
  const ehAdmin = souSupervisorPuro() ? false : $("ehAdmin").checked;
  const ehSup = souSupervisorPuro() ? false : $("ehSupervisor").checked;

  // Membro cadastrado por supervisor precisa pertencer a pelo menos um
  // departamento (dos que ele supervisiona) - nunca "sem restricao".
  if (souSupervisorPuro() && marcados.length === 0) {
    $("erroAcesso").textContent = "Selecione pelo menos um departamento para esta pessoa.";
    return;
  }

  // Supervisor so tem poder dentro dos departamentos marcados - sem nenhum
  // marcado, "supervisor" nao significaria nada.
  if (ehSup && !ehAdmin && marcados.length === 0) {
    $("erroAcesso").textContent = "Supervisor precisa de pelo menos um departamento marcado.";
    return;
  }

  // Regra do ultimo administrador: nao deixa retirar o admin de alguem se isso
  // deixar o sistema sem nenhum administrador.
  if (editandoAcesso && !ehAdmin && removendoUltimoAdmin(editandoAcesso)) {
    $("erroAcesso").textContent =
      "É obrigatório ter pelo menos um administrador. Marque outro administrador antes de retirar este.";
    return;
  }

  const btn = $("salvarAcesso");
  btn.disabled = true;

  try {
    // setDoc com o e-mail como id: cria ou substitui, sem risco de duplicar.
    await setDoc(
      doc(db, COLECAO_ACESSOS, email),
      {
        email,
        departamentos: marcados,
        admin: ehAdmin,
        supervisor: ehSup,
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
    $("erroAcesso").textContent =
      err.code === "permission-denied"
        ? "O Firestore recusou a gravação. Publique as regras de firestore.rules no console."
        : "Erro ao salvar. Verifique a conexão.";
  } finally {
    btn.disabled = false;
  }
});

// true se `email` e administrador hoje e nao existe NENHUM outro administrador
// cadastrado - ou seja, tirar o admin dele deixaria o sistema sem nenhum.
function removendoUltimoAdmin(email) {
  const alvo = acessos.find((a) => a.id === email);
  if (!alvo || !alvo.admin) return false;
  return acessos.filter((a) => a.admin && a.id !== email).length === 0;
}

async function excluirAcesso(ac) {
  if (souSupervisorPuro() && !acessoGerenciavelPorSup(ac)) return;
  if (ac.admin && removendoUltimoAdmin(ac.id)) {
    $("erroAcesso").textContent =
      "É obrigatório ter pelo menos um administrador. Este é o único — marque outro como administrador antes de remover.";
    return;
  }
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


// Esta pagina exige permissao de administrador (campo `admin` em kanban_acessos).
// Excecao de primeiro acesso: se NENHUM administrador existir ainda, o primeiro
// usuario autenticado consegue entrar e se cadastrar - senao o cadastro nasceria
// trancado, sem ninguem capaz de abrir.
protegerPagina({ exigirAdmin: false }).then((logado) => {
  const ehSupervisor = logado.permissao.supervisor === true;
  // So admin e supervisor abrem a configuracao. Em modo aberto (setup inicial),
  // qualquer logado entra para cadastrar o primeiro administrador. O dono entra
  // sempre (e admin pela regra), entao nunca se fica sem quem configure.
  // Supervisor entra numa versao limitada (listas/subtarefas e acessos dos deps dele).
  const podeEntrar = logado.permissao.admin || ehSupervisor || ADMIN_ABERTO;

  if (!podeEntrar) {
    document.body.innerHTML =
      '<div class="sem-permissao">' +
      '<h1>Acesso restrito</h1>' +
      `<p><strong>${escapeHtml(logado.email)}</strong> não tem permissão de administrador.</p>` +
      '<p>A configuração é só para administradores. Você ainda pode acompanhar ' +
      'o <a href="relatorio.html">Relatório</a> e a <a href="auditoria.html">Auditoria</a> ' +
      'dos seus departamentos.</p>' +
      '<p><a class="btn-ghost" href="index.html">← Voltar ao quadro</a></p>' +
      "</div>";
    return;
  }

  permissaoAtual = logado.permissao;
  montarBarraUsuario($("barraUsuario"), logado);
  ajustarSubmenu(logado.permissao);

  // Supervisor (que nao e admin) so gerencia listas/subtarefas dos deps dele:
  // esconde os paineis de Departamentos e de Acessos.
  if (ehSupervisor && !logado.permissao.admin) aplicarModoSupervisor();

  renderCheckboxes();
  renderColunas();
  renderSubs();
  escutarTudo();
});

// Deixa a tela de configuracao so com o painel de Listas/Subtarefas.
function aplicarModoSupervisor() {
  // Supervisor NAO cria/exclui/renomeia departamentos - esconde so esse painel.
  // O painel de Acessos fica, porem restrito aos departamentos dele.
  const dep = $("painelDepartamentos");
  if (dep) dep.style.display = "none";
  restringirAcessosAoSupervisor();
  const sub = document.querySelector(".topbar p");
  if (sub) sub.textContent =
    "VR Software — Unidade Minas Gerais · listas, subtarefas e acessos dos seus departamentos";
}

// No painel de Acessos, o supervisor so cadastra membros comuns: esconde os
// checkboxes de papel (admin e supervisor) e ajusta a dica.
function restringirAcessosAoSupervisor() {
  const la = $("ehAdmin").closest(".check-admin");
  const ls = $("ehSupervisor").closest(".check-admin");
  if (la) la.style.display = "none";
  if (ls) ls.style.display = "none";
  const hint = document.querySelector("#painelAcessos .painel-hint");
  if (hint) hint.textContent =
    "Você gerencia as pessoas dos seus departamentos. Não é possível definir administradores.";
}

function souSupervisorPuro() {
  return !!(permissaoAtual && permissaoAtual.supervisor && !permissaoAtual.admin);
}

// Acesso que o supervisor pode gerenciar: membro comum (nem admin nem
// supervisor) cujos departamentos estao TODOS dentro dos que ele supervisiona.
function acessoGerenciavelPorSup(ac) {
  if (!ac || ac.admin || ac.supervisor) return false;
  const meus = (permissaoAtual && permissaoAtual.departamentos) || [];
  return ac.departamentos.length > 0 && ac.departamentos.every((d) => meus.includes(d));
}
