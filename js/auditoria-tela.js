/* ==========================================================================
   auditoria-tela.js - Leitura da trilha de auditoria
   --------------------------------------------------------------------------
   Lista kanban_auditoria em ordem decrescente de data. Cada linha e um fato:
   quem, quando, em qual tarefa, e o que mudou (de -> para).

   Pagina so os ultimos LIMITE registros: a trilha cresce para sempre e nao faz
   sentido trazer tudo para a tela.
   ========================================================================== */

import { db, COLECAO_AUDITORIA, COLECAO_DEPARTAMENTOS } from "./firebase-config.js";
import { protegerPagina, montarBarraUsuario } from "./auth.js";
import { descrever } from "./auditoria.js";
import { formatarDataISO } from "./cronograma.js";
import {
  collection, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const LIMITE = 500;

let usuario = null;
let registros = [];
let departamentos = [];
let conectado = false;

const $ = (id) => document.getElementById(id);

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

/* -------------------------------------------------------------------------- */

function escutar() {
  const opcoes = { includeMetadataChanges: true };

  onSnapshot(collection(db, COLECAO_DEPARTAMENTOS), (snap) => {
    departamentos = snap.docs
      .map((d) => (d.data().nome || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    montarFiltroDepartamento();
    render();
  }, (e) => console.warn("[auditoria] departamentos:", e.code || e));

  // orderBy + limit no servidor: so os registros mais recentes trafegam.
  const consulta = query(
    collection(db, COLECAO_AUDITORIA),
    orderBy("em", "desc"),
    limit(LIMITE)
  );

  onSnapshot(consulta, opcoes, (snap) => {
    registros = snap.docs.map((d) => {
      const dados = d.data({ serverTimestamps: "estimate" });
      return {
        id: d.id,
        tarefaId: dados.tarefaId || "",
        tarefaTitulo: dados.tarefaTitulo || "",
        departamento: dados.departamento || "",
        acao: dados.acao || "",
        alvo: dados.alvo || "",
        campo: dados.campo || "",
        de: dados.de || "",
        para: dados.para || "",
        porEmail: dados.porEmail || "",
        porNome: dados.porNome || dados.porEmail || "",
        em: dados.em || null
      };
    });

    if (!snap.metadata.fromCache) {
      conectado = true;
      setLive(true, "ao vivo");
    } else if (!conectado) {
      setLive(false, "sem conexão");
    }

    montarFiltroQuem();
    render();
  }, (erro) => {
    console.error("[auditoria] falha ao ler:", erro);
    setLive(false, erro.code === "permission-denied" ? "sem permissão" : "offline");
    setStatus(
      erro.code === "failed-precondition"
        ? "O Firestore pediu um índice para esta consulta. Abra o console (F12): " +
          "o erro traz um link que cria o índice com um clique."
        : `Não foi possível ler a auditoria (${erro.code || erro.message}).`,
      true
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Filtros                                                                    */
/* -------------------------------------------------------------------------- */

function montarFiltroDepartamento() {
  const sel = $("filtroDep");
  const anterior = sel.value;
  const meus = usuario && usuario.permissao.veTudo
    ? departamentos
    : departamentos.filter((d) => usuario && usuario.permissao.departamentos.includes(d));

  sel.innerHTML = '<option value="">Todos</option>' +
    meus.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  if (meus.includes(anterior)) sel.value = anterior;
}

function montarFiltroQuem() {
  const sel = $("filtroQuem");
  const anterior = sel.value;
  const nomes = [...new Set(registros.map((r) => r.porNome).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  sel.innerHTML = '<option value="">Todos</option>' +
    nomes.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (nomes.includes(anterior)) sel.value = anterior;
}

function dataDoRegistro(reg) {
  if (!reg.em || typeof reg.em.toDate !== "function") return null;
  return reg.em.toDate();
}

function isoDoRegistro(reg) {
  const d = dataDoRegistro(reg);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function filtrados() {
  const dep = $("filtroDep").value;
  const quem = $("filtroQuem").value;
  const tipo = $("filtroAcao").value;
  const busca = $("filtroBusca").value.trim().toLowerCase();
  const de = $("filtroDe").value;
  const ate = $("filtroAte").value;

  // Quem nao e administrador so ve a trilha dos departamentos que acompanha.
  const permitidos = usuario && usuario.permissao.veTudo ? null : (usuario ? usuario.permissao.departamentos : []);

  return registros.filter((r) => {
    if (permitidos && r.departamento && !permitidos.includes(r.departamento)) return false;
    if (dep && r.departamento !== dep) return false;
    if (quem && r.porNome !== quem) return false;
    if (tipo && r.alvo !== tipo) return false;
    if (busca && !r.tarefaTitulo.toLowerCase().includes(busca)) return false;

    const iso = isoDoRegistro(r);
    if (de && iso && iso < de) return false;
    if (ate && iso && iso > ate) return false;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

function quando(reg) {
  const d = dataDoRegistro(reg);
  if (!d) return "—";
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${formatarDataISO(isoDoRegistro(reg))} ${hora}`;
}

function render() {
  const corpo = $("corpo");
  const lista = filtrados();
  corpo.innerHTML = "";

  if (!lista.length) {
    corpo.innerHTML = '<tr><td colspan="4" class="vazio">Nenhuma alteração registrada neste recorte.</td></tr>';
    setStatus(registros.length ? "Nenhum registro no filtro atual." : "Nenhuma alteração registrada ainda.");
    return;
  }

  let diaAnterior = "";

  lista.forEach((reg) => {
    const dia = isoDoRegistro(reg);

    // Cabecalho por dia: facilita achar "o que mudou na terca".
    if (dia !== diaAnterior) {
      diaAnterior = dia;
      const sep = document.createElement("tr");
      sep.className = "linha-dia";
      sep.innerHTML = `<td colspan="4">${escapeHtml(formatarDataISO(dia) || "sem data")}</td>`;
      corpo.appendChild(sep);
    }

    const tr = document.createElement("tr");
    tr.className = "linha-aud " + (reg.alvo === "subtarefa" ? "de-etapa" : "de-tarefa");
    tr.innerHTML = `
      <td class="col-quando">${escapeHtml(quando(reg))}</td>
      <td class="col-quem"><span class="quem-chip" title="${escapeHtml(reg.porEmail)}">${escapeHtml(reg.porNome || "—")}</span></td>
      <td class="col-titulo">
        <div class="celula-flex">
          <strong>${escapeHtml(reg.tarefaTitulo || "—")}</strong>
          ${reg.departamento ? `<span class="resp">${escapeHtml(reg.departamento)}</span>` : ""}
        </div>
      </td>
      <td class="col-mudanca">${montarMudanca(reg)}</td>
    `;
    corpo.appendChild(tr);
  });

  setStatus(
    `${lista.length} ${lista.length === 1 ? "registro" : "registros"}` +
    (registros.length >= LIMITE ? ` · mostrando as ${LIMITE} alterações mais recentes` : "")
  );
}

// Para alteracao de campo, mostra "de -> para" em destaque; nos demais casos,
// a frase pronta ja diz tudo.
function montarMudanca(reg) {
  const texto = escapeHtml(descrever(reg));

  if (reg.acao === "alterou" && reg.de && reg.para) {
    return `<span class="acao">${texto}</span>
      <div class="de-para">
        <span class="antes">${escapeHtml(reg.de)}</span>
        <span class="seta">→</span>
        <span class="depois">${escapeHtml(reg.para)}</span>
      </div>`;
  }
  return `<span class="acao ${reg.acao}">${texto}</span>`;
}

/* -------------------------------------------------------------------------- */
/* Exportar                                                                   */
/* -------------------------------------------------------------------------- */

function exportarCsv() {
  const linhas = [["Quando", "Quem", "E-mail", "Departamento", "Tarefa", "Alvo", "Acao", "Campo", "De", "Para"]];

  filtrados().forEach((r) => {
    linhas.push([
      quando(r), r.porNome, r.porEmail, r.departamento, r.tarefaTitulo,
      r.alvo, descrever(r), r.campo, r.de, r.para
    ]);
  });

  const csv = linhas
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* -------------------------------------------------------------------------- */

["filtroDep", "filtroQuem", "filtroAcao", "filtroDe", "filtroAte"].forEach((id) =>
  $(id).addEventListener("change", render)
);
$("filtroBusca").addEventListener("input", render);
$("limpar").addEventListener("click", () => {
  ["filtroDep", "filtroQuem", "filtroAcao", "filtroDe", "filtroAte", "filtroBusca"]
    .forEach((id) => { $(id).value = ""; });
  render();
});
$("exportarCsv").addEventListener("click", exportarCsv);

protegerPagina().then((logado) => {
  usuario = logado;
  montarBarraUsuario($("barraUsuario"), logado);
  montarFiltroDepartamento();
  escutar();
});
