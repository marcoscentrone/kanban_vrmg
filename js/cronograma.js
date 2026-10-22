/* ==========================================================================
   cronograma.js - Datas, prazos e cores do quadro
   --------------------------------------------------------------------------
   Tudo o que calcula TEMPO fica aqui, e nao dentro de kanban.js, porque o
   relatorio (relatorio.html) precisa mostrar exatamente as mesmas contas que o
   card mostra no tooltip. Duas copias da mesma formula divergiriam na primeira
   correcao que alguem fizesse so de um lado.
   ========================================================================== */

import { ESTADO_INFO } from "./subtarefas.js";

export const MS_POR_DIA = 86400000;

// Janela em que uma tarefa comeca a "esquentar" pela proximidade da data:
// a 14 dias do termino ela sai do verde e caminha para o vermelho.
export const JANELA_ALERTA_DIAS = 14;

/* ---- Datas em texto "AAAA-MM-DD" ---------------------------------------- */
/* Guardar data como texto (e nao Timestamp) evita deslocamento de fuso: o
   servidor nunca "empurra" 22/09 para 21/09 conforme o fuso de quem le.      */

export function hojeISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function somarDias(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function diasEntre(isoA, isoB) {
  return Math.round(
    (new Date(isoB + "T00:00:00") - new Date(isoA + "T00:00:00")) / MS_POR_DIA
  );
}

// "2026-09-22" -> "22/09" (ou "22/09/27" se for de outro ano)
export function formatarDataISO(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}` + (ano !== String(new Date().getFullYear()) ? `/${ano.slice(2)}` : "");
}

export function plural(n, singular = "dia", plural_ = "dias") {
  return `${n} ${Math.abs(n) === 1 ? singular : plural_}`;
}

/* ---- Prazo da tarefa ----------------------------------------------------- */

// Quao perto a tarefa esta do termino previsto, de 0 (recem-comecada) a 1
// (no prazo final ou vencida). null = nao da para medir.
// `ehFinal` indica que a tarefa esta na lista de conclusao: ai nao ha prazo.
export function progressoPrazo(card, ehFinal = false) {
  if (ehFinal || !card.fimPrevisto) return null;

  // Todas as etapas concluidas: a tarefa esta pronta, nao ha mais prazo a cobrar
  // (a bolinha fica verde e para de contar o periodo).
  const subs = (card && card.subtarefas) || [];
  if (subs.length > 0 && subs.every((s) => s.estado === "feito")) return null;

  const hoje = new Date(hojeISO() + "T00:00:00");
  const fim = new Date(card.fimPrevisto + "T00:00:00");
  if (hoje >= fim) return 1; // venceu hoje ou ja passou

  // (a) Proximidade no calendario: quanto falta para a data, sem olhar o
  //     tamanho do prazo. Vence amanha = quase 1, mesmo comecando hoje.
  const diasAteFim = (fim - hoje) / MS_POR_DIA;
  const porCalendario = Math.min(1, Math.max(0, 1 - diasAteFim / JANELA_ALERTA_DIAS));

  // (b) Fatia do prazo ja consumida. Uma tarefa de 6 meses com 90% do tempo
  //     gasto merece atencao, ainda que a data final esteja longe.
  let porPrazo = 0;
  if (card.inicioPrevisto && card.inicioPrevisto < card.fimPrevisto) {
    const ini = new Date(card.inicioPrevisto + "T00:00:00");
    porPrazo = Math.min(1, Math.max(0, (hoje - ini) / (fim - ini)));
  }

  return Math.max(porCalendario, porPrazo); // vale o pior dos dois
}

// Quantos dias faltam para o termino da tarefa (negativo = atrasada).
export function diasAteOFim(card) {
  if (!card.fimPrevisto) return null;
  return diasEntre(hojeISO(), card.fimPrevisto);
}

// Frase pronta sobre o prazo da tarefa.
export function textoPrazoTarefa(card, ehFinal = false) {
  if (ehFinal) return "concluída";
  const dias = diasAteOFim(card);
  if (dias === null) return "sem prazo";
  if (dias < 0) return `atrasada ${plural(-dias)}`;
  if (dias === 0) return "termina hoje";
  return `faltam ${plural(dias)}`;
}

/* ---- Cores --------------------------------------------------------------- */

// >>> INTENSIDADE DAS CAIXAS DE SUBTAREFA <<<
// 1 = cor cheia (forte)   0.5 = metade   0.25 = bem suave
export const OPACIDADE_SUBTAREFA = 0.30;

// Interpolacao em HSL entre tres ancoras, NUNCA em RGB: misturar verde e
// vermelho no espaco RGB produz marrom, e baixar saturacao/luminosidade no meio
// do caminho produz oliva e vinho.
//   p = 0.0 -> #22c55e   p = 0.5 -> #eab308   p = 1.0 -> #ef4444
export const ANCORAS_PRAZO = [
  { h: 142, s: 71, l: 45 },   // verde
  { h: 45,  s: 93, l: 47 },   // amarelo
  { h: 0,   s: 84, l: 60 }    // vermelho
];

export function corDoPrazo(p, opacidade = 1) {
  const t = Math.min(1, Math.max(0, p));

  const [de, para, fatia] = t < 0.5
    ? [ANCORAS_PRAZO[0], ANCORAS_PRAZO[1], t / 0.5]
    : [ANCORAS_PRAZO[1], ANCORAS_PRAZO[2], (t - 0.5) / 0.5];

  const entre = (a, b) => a + (b - a) * fatia;
  const h = Math.round(entre(de.h, para.h));
  const sat = Math.round(entre(de.s, para.s));
  const luz = Math.round(entre(de.l, para.l));

  return `hsla(${h}, ${sat}%, ${luz}%, ${opacidade})`;
}

/* ---- Cronograma das subtarefas ------------------------------------------ */

// Janela de datas de cada subtarefa pendente.
//
// O tempo que ainda resta da tarefa (de hoje ate o termino) e dividido
// igualmente entre as R pendentes, em blocos sequenciais:
//
//   30 dias / 5 etapas -> 6 dias cada
//   1-1: 17/09 a 23/09   1-2: 24/09 a 29/09   1-3: 30/09 a 05/10 ...
//
// Concluir uma etapa antes do prazo nao deixa tempo parado: as pendentes
// recalculam e ganham blocos maiores.
export function janelasDasSubtarefas(card) {
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

// Frase sobre o tempo de UMA subtarefa. Distingue duas coisas que se confundem:
//   - o TAMANHO da janela (quanto tempo a etapa tem para ser feita)
//   - QUANDO essa janela vence (contado de hoje)
// A 1a etapa comeca hoje, entao para ela as duas coincidem.
export function textoPrazoSubtarefa(sub, janela) {
  if (sub.estado === "feito") return "concluída";
  if (!janela) return "sem prazo";
  if (janela.vencido) return "prazo da tarefa vencido";

  const hoje = hojeISO();
  const ateOFim = diasEntre(hoje, janela.fim);
  const ateOComeco = diasEntre(hoje, janela.inicio);
  const tamanho = diasEntre(janela.inicio, janela.fim) + 1;

  if (ateOFim < 0) return `atrasada ${plural(-ateOFim)}`;
  if (ateOComeco <= 0) {
    return ateOFim === 0 ? "termina hoje" : `faltam ${plural(ateOFim)} para terminar`;
  }
  return `${plural(tamanho)} de prazo · começa em ${plural(ateOComeco)}`;
}

// Periodo da subtarefa em texto: "17/09 a 23/09".
export function periodoSubtarefa(janela) {
  if (!janela || janela.vencido) return "—";
  return `${formatarDataISO(janela.inicio)} a ${formatarDataISO(janela.fim)}`;
}

// Tooltip do card: estado + periodo + tempo + a dica de clique.
export function tituloSubtarefa(sub, janela) {
  const info = ESTADO_INFO[sub.estado] || ESTADO_INFO.pendente;

  if (sub.estado === "feito") return "concluída";
  if (!janela) return `${info.rotulo} — clique para mudar`;
  if (janela.vencido) return `${info.rotulo} — prazo do card vencido\nClique para mudar`;

  return `${info.rotulo} · ${periodoSubtarefa(janela)}\n` +
         `${textoPrazoSubtarefa(sub, janela)}\nClique para mudar`;
}

/* ---- Cor de cada subtarefa: ORDEM DE URGENCIA --------------------------- */

// Concluidas ficam VERDES para sempre - saem da fila e do rateio.
//
// Entre as R pendentes, a 1a e a que precisa sair agora (mais quente) e a
// ultima e a mais folgada (verde). Esse gradiente e deslocado pelo quanto a
// tarefa ja consumiu do proprio prazo:
//
//     urgencia(i) = p + (1 - p) * (1 - i / R)
//
//   . tarefa no inicio (p=0) -> gradiente cheio: 1a quente, ultima verde
//   . tarefa vencida (p=1)   -> todas vermelhas, nao importa a posicao
//   . concluir uma etapa     -> R diminui e as restantes esfriam
export function coresDasSubtarefas(card, ehFinal = false, opacidade = OPACIDADE_SUBTAREFA) {
  const subs = card.subtarefas || [];
  const cores = new Map();
  if (!subs.length) return cores;

  const p = progressoPrazo(card, ehFinal);
  const pendentes = subs.filter((s) => s.estado !== "feito");
  const total = pendentes.length;

  subs.forEach((s) => {
    if (s.estado === "feito") cores.set(s.id, corDoPrazo(0, opacidade));
  });

  if (p === null) return cores;   // sem cronograma: pendentes ficam neutras

  pendentes.forEach((s, i) => {
    const posicaoNaFila = 1 - (i + 1) / total;   // 1a = mais alta, ultima = 0
    cores.set(s.id, corDoPrazo(p + (1 - p) * posicaoNaFila, opacidade));
  });

  return cores;
}
