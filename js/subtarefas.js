/* ==========================================================================
   subtarefas.js - Etapas dentro de cada tarefa
   --------------------------------------------------------------------------
   Hierarquia do quadro:

     departamento  ->  listas (colunas)  ->  tarefas  ->  SUBTAREFAS

   Cada departamento pode ter um roteiro padrao, cadastrado na area
   administrativa:

     kanban_departamentos/{id}.subtarefasPadrao = ["Migracao padrao", ...]

   Toda tarefa criada naquele departamento ja nasce com essas etapas copiadas
   para dentro dela:

     kanban_cards/{id}.subtarefas = [ { id, nome, estado }, ... ]   (ate 6)

   A copia e proposital: mudar o roteiro padrao depois NAO mexe nas tarefas que
   ja existem, senao o histórico de quem ja concluiu etapas seria reescrito.
   ========================================================================== */

export const MAX_SUBTAREFAS = 6;

// Ciclo de estados de uma etapa, na ordem em que o clique avanca.
export const ESTADOS = ["pendente", "fazendo", "feito"];

export const ESTADO_INFO = {
  pendente: { rotulo: "a fazer", icone: "○" },
  fazendo:  { rotulo: "fazendo", icone: "◑" },
  feito:    { rotulo: "feito",   icone: "✓" }
};

export function proximoEstado(estado) {
  const i = ESTADOS.indexOf(estado);
  return ESTADOS[(i + 1) % ESTADOS.length];
}

// Subtarefas gravadas numa tarefa, com validacao.
export function lerSubtarefas(dados) {
  const bruto = Array.isArray(dados && dados.subtarefas) ? dados.subtarefas : [];
  return bruto
    .filter((s) => s && typeof s.nome === "string")
    .map((s, i) => ({
      id: typeof s.id === "string" && s.id ? s.id : `s${i + 1}`,
      nome: s.nome.trim(),
      estado: ESTADOS.includes(s.estado) ? s.estado : "pendente",
      comentario: typeof s.comentario === "string" ? s.comentario.slice(0, 50) : ""
    }))
    .filter((s) => s.nome)
    .slice(0, MAX_SUBTAREFAS);
}

// Roteiro padrao de um departamento: apenas os nomes, na ordem.
export function lerPadroes(dados) {
  const bruto = Array.isArray(dados && dados.subtarefasPadrao) ? dados.subtarefasPadrao : [];
  return bruto
    .filter((n) => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, MAX_SUBTAREFAS);
}

// Id curto e unico dentro da propria tarefa.
export function gerarIdSubtarefa(jaUsados = []) {
  let n = 1;
  while (jaUsados.includes(`s${n}`)) n++;
  return `s${n}`;
}

// Monta as subtarefas de uma tarefa nova a partir do roteiro do departamento.
export function subtarefasIniciais(padroes) {
  return (padroes || []).slice(0, MAX_SUBTAREFAS).map((nome, i) => ({
    id: `s${i + 1}`,
    nome,
    estado: "pendente"
  }));
}

// Quantas etapas ja foram concluidas - usado no resumo do card.
export function progresso(subtarefas) {
  const total = (subtarefas || []).length;
  const feitas = (subtarefas || []).filter((s) => s.estado === "feito").length;
  return { feitas, total, completo: total > 0 && feitas === total };
}
