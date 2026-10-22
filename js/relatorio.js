/* ==========================================================================
   relatorio.js - Tarefas e etapas em formato de planilha
   --------------------------------------------------------------------------
   Mesma origem de dados do quadro (kanban_cards) e os MESMOS calculos de prazo
   (js/cronograma.js). O que o card mostra no tooltip, esta tela mostra em
   coluna - sem recalcular nada por conta propria.

   Cada tarefa vira uma linha; as etapas dela viram linhas logo abaixo, recuadas.
   ========================================================================== */

import {
  db, COLECAO_CARDS, COLECAO_DEPARTAMENTOS,
  COLECAO_FINALIZADOS, COLECAO_CANCELADOS
} from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario, ajustarSubmenu } from "./auth.js";
import { colunasDe, lerColunas } from "./colunas.js";
import { lerSubtarefas, ESTADO_INFO, progresso } from "./subtarefas.js";
import {
  hojeISO, formatarDataISO, janelasDasSubtarefas, periodoSubtarefa,
  textoPrazoSubtarefa, textoPrazoTarefa, progressoPrazo, corDoPrazo,
  coresDasSubtarefas, diasAteOFim
} from "./cronograma.js";
import {
  collection, onSnapshot, query, where, doc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { registrarRestauracao } from "./auditoria.js";

/* -------------------------------------------------------------------------- */
/* Estado                                                                     */
/* -------------------------------------------------------------------------- */

let usuario = null;
let cards = [];
let departamentos = [];      // [{id, nome, colunas}]
let conectado = false;
let unsubs = [];
let depAssinado = null;
// Tarefas por origem: ativas (quadro), finalizadas e canceladas (arquivo).
const fontes = { ativa: [], finalizada: [], cancelada: [] };

const $ = (id) => document.getElementById(id);

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

/* -------------------------------------------------------------------------- */
/* Leitura                                                                    */
/* -------------------------------------------------------------------------- */

function escutar() {
  const opcoes = { includeMetadataChanges: true };

  onSnapshot(collection(db, COLECAO_DEPARTAMENTOS), opcoes, (snap) => {
    departamentos = snap.docs
      .map((d) => ({
        id: d.id,
        nome: (d.data().nome || "").trim(),
        colunas: lerColunas(d.data())
      }))
      .filter((d) => d.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    montarFiltroDepartamento();
    if ($("filtroDep").value !== depAssinado) escutarCards();
    render();
  }, erroDe("departamentos"));

  // os cards sao assinados por departamento em escutarCards()
}

// Assina (ou re-assina) os cards SO do departamento escolhido. A regra do
// Firestore so libera a leitura quando a query pede um departamento permitido.
// Usuario comum (nem admin, nem supervisor, nem "ve tudo") so pode ler as
// tarefas em que ele e o responsavel - igual ao quadro.
function soVeProprias() {
  return !!(usuario && !usuario.permissao.admin
    && !usuario.permissao.supervisor && !usuario.permissao.veTudo);
}

function mapCard(d, situacao) {
  const dados = d.data({ serverTimestamps: "estimate" });
  return {
    id: d.id,
    titulo: dados.titulo || "",
    descricao: dados.descricao || "",
    coluna: dados.coluna || "",
    departamento: dados.departamento || "",
    responsavel: dados.responsavel || "",
    responsavelEmail: (dados.responsavelEmail || "").toLowerCase(),
    prioridade: dados.prioridade || "media",
    inicioPrevisto: typeof dados.inicioPrevisto === "string" ? dados.inicioPrevisto : "",
    fimPrevisto: typeof dados.fimPrevisto === "string" ? dados.fimPrevisto : "",
    subtarefas: lerSubtarefas(dados),
    criadoPor: (dados.criadoPor || "").toLowerCase(),
    criadoEm: dados.criadoEm || null,
    finalizadoEm: dados.finalizadoEm || null,
    situacao
  };
}

// Consulta de uma colecao, respeitando o papel. Usuario comum so le as proprias
// (no quadro, tambem as sem responsavel; no arquivo, so onde ele e o responsavel).
function consultaDe(col) {
  const dep = $("filtroDep").value;
  const ref = collection(db, col);
  if (!soVeProprias()) return query(ref, where("departamento", "==", dep));
  if (col === COLECAO_CARDS) {
    return query(ref, where("departamento", "==", dep),
      where("responsavelEmail", "in", [usuario.email, ""]));
  }
  return query(ref, where("departamento", "==", dep),
    where("responsavelEmail", "==", usuario.email));
}

function rebuildCards() {
  cards = [...fontes.ativa, ...fontes.finalizada, ...fontes.cancelada];
  montarFiltroResponsavel();
  render();
}

function escutarCards() {
  const dep = $("filtroDep").value;
  unsubs.forEach((u) => u());
  unsubs = [];
  depAssinado = dep;
  fontes.ativa = []; fontes.finalizada = []; fontes.cancelada = [];

  if (!dep) { cards = []; render(); return; }

  const opcoes = { includeMetadataChanges: true };
  [
    [COLECAO_CARDS, "ativa"],
    [COLECAO_FINALIZADOS, "finalizada"],
    [COLECAO_CANCELADOS, "cancelada"]
  ].forEach(([col, situacao]) => {
    const u = onSnapshot(consultaDe(col), opcoes, (snap) => {
      fontes[situacao] = snap.docs.map((d) => mapCard(d, situacao));
      if (!snap.metadata.fromCache) {
        conectado = true;
        setLive(true, snap.metadata.hasPendingWrites ? "salvando…" : "ao vivo");
      } else if (!conectado) {
        setLive(false, "sem conexão");
      }
      rebuildCards();
    }, erroDe(situacao === "ativa" ? "tarefas" : "arquivo"));
    unsubs.push(u);
  });
}

function erroDe(qual) {
  return (erro) => {
    console.error(`[relatorio] falha ao ler ${qual}:`, erro);
    setLive(false, erro.code === "permission-denied" ? "sem permissão" : "offline");
    setStatus(`Não foi possível ler ${qual} (${erro.code || erro.message}).`, true);
  };
}

/* -------------------------------------------------------------------------- */
/* Filtros                                                                    */
/* -------------------------------------------------------------------------- */

// So os departamentos que a pessoa participa. Administrador ve todos.
function departamentosDoUsuario() {
  if (!usuario) return [];
  if (usuario.permissao.veTudo) return departamentos;
  return departamentos.filter((d) => usuario.permissao.departamentos.includes(d.nome));
}

function montarFiltroDepartamento() {
  const sel = $("filtroDep");
  const anterior = sel.value;
  const meus = departamentosDoUsuario();

  sel.innerHTML = meus.length
    ? meus.map((d) => `<option value="${escapeHtml(d.nome)}">${escapeHtml(d.nome)}</option>`).join("")
    : '<option value="">— nenhum departamento —</option>';

  if (meus.some((d) => d.nome === anterior)) sel.value = anterior;
  montarFiltroLista();
  montarFiltroResponsavel();
}

// As listas mudam conforme o departamento escolhido.
function montarFiltroLista() {
  const sel = $("filtroLista");
  const anterior = sel.value;
  const dep = depAtual();
  const colunas = dep ? colunasDe(dep) : [];

  sel.innerHTML = '<option value="">Todas</option>' +
    colunas.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}</option>`).join("");

  if (colunas.some((c) => c.id === anterior)) sel.value = anterior;
}

// Os responsaveis vem das proprias tarefas do departamento escolhido - assim a
// lista nunca oferece alguem que nao tem tarefa ali. Muda junto com o
// departamento e tambem quando chega tarefa nova pelo onSnapshot.
function montarFiltroResponsavel() {
  const sel = $("filtroResp");
  const anterior = sel.value;
  const dep = $("filtroDep").value;

  const doDepartamento = cards.filter((c) => c.departamento === dep);
  const nomes = [...new Set(doDepartamento.map((c) => (c.responsavel || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const temSemResponsavel = doDepartamento.some((c) => !(c.responsavel || "").trim());

  sel.innerHTML =
    '<option value="">Todos</option>' +
    nomes.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("") +
    (temSemResponsavel ? '<option value="__sem__">— sem responsável —</option>' : "");

  // mantem a escolha se ela ainda existir neste departamento
  const aindaVale =
    !anterior ||
    nomes.includes(anterior) ||
    (anterior === "__sem__" && temSemResponsavel);
  sel.value = aindaVale ? anterior : "";
}

function depAtual() {
  return departamentos.find((d) => d.nome === $("filtroDep").value) || null;
}

// Uma tarefa entra no relatorio se o periodo dela cruza o intervalo pedido.
// Cruzar, e nao estar contida: uma tarefa de 01/09 a 30/11 aparece num filtro
// de outubro, porque esta em andamento naquele mes.
function dentroDoPeriodo(card) {
  const de = $("filtroDe").value;
  const ate = $("filtroAte").value;
  if (!de && !ate) return true;

  const ini = card.inicioPrevisto || card.fimPrevisto;
  const fim = card.fimPrevisto || card.inicioPrevisto;
  if (!ini && !fim) return false;          // sem datas: fica fora do recorte

  if (de && fim && fim < de) return false;
  if (ate && ini && ini > ate) return false;
  return true;
}

function cardsFiltrados() {
  const dep = $("filtroDep").value;
  const lista = $("filtroLista").value;
  const resp = $("filtroResp").value;
  const sit = $("filtroSituacao") ? $("filtroSituacao").value : "";

  return cards
    .filter((c) => c.departamento === dep)
    .filter((c) => !sit || (c.situacao || "ativa") === sit)
    .filter((c) => !lista || c.coluna === lista)
    .filter((c) => {
      if (!resp) return true;
      const nome = (c.responsavel || "").trim();
      return resp === "__sem__" ? !nome : nome === resp;
    })
    .filter(dentroDoPeriodo)
    .sort(porUrgencia);
}

// Mesma ordem do quadro: mais urgente primeiro, sem prazo por ultimo.
function porUrgencia(a, b) {
  const dep = depAtual();
  const idFinal = dep ? colunasDe(dep).slice(-1)[0].id : "";
  const pa = progressoPrazo(a, a.coluna === idFinal);
  const pb = progressoPrazo(b, b.coluna === idFinal);

  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pb !== pa) return pb - pa;
  return (a.fimPrevisto || "").localeCompare(b.fimPrevisto || "");
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

function nomeDaLista(dep, colunaId) {
  const col = colunasDe(dep).find((c) => c.id === colunaId);
  return col ? col.nome : "—";
}

// Situacao da tarefa na coluna "Estado" do relatorio.
function estadoTag(card, ehFinal) {
  if (card.situacao === "finalizada") return '<span class="tag-ok">finalizada</span>';
  if (card.situacao === "cancelada") return '<span class="tag-cancel">cancelada</span>';
  return ehFinal ? '<span class="tag-ok">concluída</span>' : "";
}

// Quem pode restaurar uma tarefa arquivada: mesma regra de quem podia arquivar
// (admin / ve-tudo / supervisor do depto / responsavel / dono).
function podeRestaurar(card) {
  if (!usuario || card.situacao === "ativa") return false;
  const p = usuario.permissao;
  if (p.admin || p.veTudo) return true;
  if (p.supervisor && (p.departamentos || []).includes(card.departamento)) return true;
  if (card.responsavelEmail && card.responsavelEmail === usuario.email) return true;
  if (card.criadoPor && card.criadoPor === usuario.email) return true;
  return false;
}

// Devolve a tarefa do arquivo para o quadro (kanban_cards), num lote atomico.
async function restaurarCard(card) {
  if (!podeRestaurar(card)) return;
  if (!confirm(`Restaurar "${card.titulo}" para o quadro?`)) return;

  const colArquivo = card.situacao === "finalizada" ? COLECAO_FINALIZADOS : COLECAO_CANCELADOS;

  // Recarimba a entrada na ultima coluna: se a tarefa volta para la, a data
  // "no quadro final desde" passa a ser a desta nova passagem; senao, fica vazia.
  const dep = depAtual();
  const idFinal = dep ? colunasDe(dep).slice(-1)[0].id : "";
  const finalizadoEmNovo = card.coluna === idFinal ? serverTimestamp() : null;

  try {
    const lote = writeBatch(db);
    lote.set(doc(db, COLECAO_CARDS, card.id), {
      titulo: card.titulo || "",
      descricao: card.descricao || "",
      coluna: card.coluna || "",
      departamento: card.departamento || "",
      responsavel: card.responsavel || "",
      responsavelEmail: card.responsavelEmail || "",
      prioridade: card.prioridade || "media",
      inicioPrevisto: card.inicioPrevisto || "",
      fimPrevisto: card.fimPrevisto || "",
      finalizadoEm: finalizadoEmNovo,
      criadoPor: card.criadoPor || "",
      criadoEm: card.criadoEm || null,
      subtarefas: card.subtarefas || [],
      atualizadoEm: serverTimestamp()
    });
    lote.delete(doc(db, colArquivo, card.id));
    await lote.commit();
    registrarRestauracao(card, { email: usuario.email, nome: nomeDoEmail(usuario.email) });
    setStatus(`"${card.titulo}" voltou para o quadro.`);
  } catch (e) {
    console.error("[relatorio] falha ao restaurar:", e);
    setStatus("Não foi possível restaurar a tarefa.", true);
  }
}

// "fulano@..." -> "Fulano" (para a autoria do registro de auditoria).
function nomeDoEmail(email) {
  return (email || "").split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

function render() {
  const corpo = $("corpo");
  const dep = depAtual();
  corpo.innerHTML = "";

  if (!dep) {
    corpo.innerHTML = '<tr><td colspan="6" class="vazio">Escolha um departamento.</td></tr>';
    setStatus("");
    return;
  }

  const lista = cardsFiltrados();

  if (!lista.length) {
    corpo.innerHTML = '<tr><td colspan="6" class="vazio">Nenhuma tarefa neste recorte.</td></tr>';
    setStatus(`${dep.nome} — nenhuma tarefa encontrada.`);
    return;
  }

  const idFinal = colunasDe(dep).slice(-1)[0].id;
  let totalEtapas = 0;
  let etapasFeitas = 0;

  lista.forEach((card) => {
    const ehFinal = card.coluna === idFinal;
    const p = progressoPrazo(card, ehFinal);
    const janelas = janelasDasSubtarefas(card);
    const cores = coresDasSubtarefas(card, ehFinal);
    const { feitas, total } = progresso(card.subtarefas);
    const completo = total > 0 && feitas === total;
    totalEtapas += total;
    etapasFeitas += feitas;

    // ---- linha da tarefa ----
    const tr = document.createElement("tr");
    tr.className = "linha-tarefa";
    const dias = diasAteOFim(card);
    const atrasada = !ehFinal && dias !== null && dias < 0;

    tr.innerHTML = `
      <td class="col-titulo">
        <div class="celula-flex">
          <span class="bolinha" style="background:${completo ? "var(--live-green)" : (p === null ? "var(--vr-gray)" : corDoPrazo(p))}"></span>
          <strong>${escapeHtml(card.titulo)}</strong>
          ${total ? `<span class="etapas-resumo">${feitas}/${total} etapas</span>` : ""}
          ${card.responsavel ? `<span class="resp">${escapeHtml(card.responsavel)}</span>` : ""}
          ${(card.situacao && card.situacao !== "ativa" && podeRestaurar(card))
            ? `<button class="btn-restaurar" title="Restaurar para o quadro">↩ restaurar</button>`
            : ""}
        </div>
      </td>
      <td class="col-estado">${estadoTag(card, ehFinal)}</td>
      <td class="col-lista">${escapeHtml(nomeDaLista(dep, card.coluna))}</td>
      <td class="col-data">${escapeHtml(formatarDataISO(card.inicioPrevisto) || "—")}</td>
      <td class="col-data">${escapeHtml(formatarDataISO(card.fimPrevisto) || "—")}</td>
      <td class="col-prazo${atrasada ? " atrasada" : ""}">${escapeHtml(textoPrazoTarefa(card, ehFinal))}</td>
    `;
    const bR = tr.querySelector(".btn-restaurar");
    if (bR) bR.onclick = () => restaurarCard(card);
    corpo.appendChild(tr);

    // ---- descricao (abaixo do titulo, acima das etapas) ----
    if (card.descricao) {
      const trDesc = document.createElement("tr");
      trDesc.className = "linha-desc";
      trDesc.innerHTML = `<td colspan="6" class="col-desc"><span class="desc-rotulo">Descrição:</span> ${escapeHtml(card.descricao)}</td>`;
      corpo.appendChild(trDesc);
    }

    // ---- linhas das etapas ----
    (card.subtarefas || []).forEach((sub, i) => {
      const janela = janelas.get(sub.id);
      const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;
      const cor = cores.get(sub.id);
      const periodo = sub.estado === "feito" ? "—" : periodoSubtarefa(janela);
      const prazo = textoPrazoSubtarefa(sub, janela);

      const linha = document.createElement("tr");
      linha.className = `linha-sub ${sub.estado}`;
      linha.innerHTML = `
        <td class="col-titulo sub-titulo">
          <div class="celula-flex">
            <span class="sub-num">1-${i + 1}</span>
            <span class="sub-nome">${escapeHtml(sub.nome)}</span>
          </div>
        </td>
        <td class="col-estado">
          <span class="estado-chip ${sub.estado}"${cor ? ` style="--cor-sub:${cor}"` : ""}>
            ${info.icone} ${escapeHtml(info.rotulo)}
          </span>
        </td>
        <td class="col-lista"></td>
        <td class="col-data" colspan="2">${escapeHtml(periodo)}</td>
        <td class="col-prazo">${escapeHtml(prazo)}</td>
      `;
      corpo.appendChild(linha);

      // comentario da etapa, logo abaixo dela, sem separacao
      if (sub.comentario && sub.comentario.trim()) {
        const linhaC = document.createElement("tr");
        linhaC.className = "linha-sub-coment";
        linhaC.innerHTML = `<td colspan="6" class="col-sub-coment">${escapeHtml(sub.comentario)}</td>`;
        corpo.appendChild(linhaC);
      }
    });
  });

  setStatus(
    `${dep.nome} — ${lista.length} ${lista.length === 1 ? "tarefa" : "tarefas"}` +
    (totalEtapas ? ` · ${etapasFeitas}/${totalEtapas} etapas concluídas` : "")
  );
}

/* -------------------------------------------------------------------------- */
/* Exportar                                                                   */
/* -------------------------------------------------------------------------- */

// CSV com ponto-e-virgula: e o separador que o Excel em portugues espera.
function exportarCsv() {
  const dep = depAtual();
  if (!dep) return;

  const idFinal = colunasDe(dep).slice(-1)[0].id;
  const linhas = [["Tipo", "Tarefa / Etapa", "Estado", "Lista", "Inicio", "Fim", "Prazo"]];

  cardsFiltrados().forEach((card) => {
    const ehFinal = card.coluna === idFinal;
    const janelas = janelasDasSubtarefas(card);

    linhas.push([
      "Tarefa",
      card.titulo,
      ehFinal ? "concluida" : "em andamento",
      nomeDaLista(dep, card.coluna),
      formatarDataISO(card.inicioPrevisto),
      formatarDataISO(card.fimPrevisto),
      textoPrazoTarefa(card, ehFinal)
    ]);

    (card.subtarefas || []).forEach((sub, i) => {
      const janela = janelas.get(sub.id);
      const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;
      linhas.push([
        "Etapa",
        `1-${i + 1} ${sub.nome}`,
        info.rotulo,
        "",
        sub.estado === "feito" ? "" : periodoSubtarefa(janela),
        "",
        textoPrazoSubtarefa(sub, janela)
      ]);
    });
  });

  const csv = linhas
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");

  // BOM para o Excel reconhecer os acentos
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `relatorio-${dep.nome.toLowerCase()}-${hojeISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* -------------------------------------------------------------------------- */
/* Eventos + boot                                                             */
/* -------------------------------------------------------------------------- */

$("filtroDep").addEventListener("change", () => {
  montarFiltroLista();
  escutarCards();   // re-assina os cards do novo departamento
  montarFiltroResponsavel();
  render();
});
$("filtroLista").addEventListener("change", render);
$("filtroResp").addEventListener("change", render);
if ($("filtroSituacao")) $("filtroSituacao").addEventListener("change", render);
$("filtroDe").addEventListener("change", render);
$("filtroAte").addEventListener("change", render);
$("limparPeriodo").addEventListener("click", () => {
  $("filtroDe").value = "";
  $("filtroAte").value = "";
  render();
});
$("exportarCsv").addEventListener("click", exportarCsv);

protegerPagina().then((logado) => {
  usuario = logado;
  montarBarraUsuario($("barraUsuario"), logado);
  ajustarSubmenu(logado.permissao);
  montarFiltroDepartamento();
  escutar();
});
