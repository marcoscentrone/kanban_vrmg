/* ==========================================================================
   colunas.js - Listas (colunas) de cada departamento
   --------------------------------------------------------------------------
   Cada departamento tem seu proprio fluxo, cadastrado na area administrativa:

     kanban_departamentos/{id}.colunas = [ { id, nome }, ... ]   (ate 6)

   O campo `coluna` de cada tarefa guarda o ID da lista, nunca o nome. Por isso
   renomear uma lista NAO move nenhuma tarefa: o id continua o mesmo.

   Departamento sem `colunas` cadastradas usa COLUNAS_PADRAO - que mantem os ids
   antigos (backlog, analise, ...) para nao orfanar as tarefas ja existentes.
   ========================================================================== */

export const MAX_COLUNAS = 6;

export const COLUNAS_PADRAO = [
  { id: "backlog",    nome: "Demanda"    },
  { id: "analise",    nome: "Análise"    },
  { id: "fazendo",    nome: "Fazendo"    },
  { id: "aguardando", nome: "Aguardando" },
  { id: "testando",   nome: "Testando"   },
  { id: "finalizado", nome: "Finalizado" }
];

// A ultima lista de um fluxo e a de conclusao: e nela que vale a retencao de
// 30 dias e onde a "urgencia" deixa de ser calculada.
export function idColunaFinal(colunas) {
  const lista = colunas && colunas.length ? colunas : COLUNAS_PADRAO;
  return lista[lista.length - 1].id;
}

// Le as colunas de um documento de departamento, com validacao: so entradas
// com id e nome, no maximo MAX_COLUNAS.
export function lerColunas(dados) {
  const bruto = Array.isArray(dados && dados.colunas) ? dados.colunas : [];
  const limpas = bruto
    .filter((c) => c && typeof c.id === "string" && typeof c.nome === "string")
    .map((c) => ({ id: c.id, nome: c.nome.trim() }))
    .filter((c) => c.id && c.nome)
    .slice(0, MAX_COLUNAS);
  return limpas;
}

// Colunas efetivas de um departamento (as dele, ou o padrao).
export function colunasDe(departamento) {
  const c = departamento && departamento.colunas;
  return c && c.length ? c : COLUNAS_PADRAO;
}

// Id estavel a partir do nome. Mantido para sempre, mesmo que o nome mude.
export function gerarIdColuna(nome, jaUsados = []) {
  const base =
    (nome || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lista";

  let id = base;
  let n = 2;
  while (jaUsados.includes(id)) id = `${base}-${n++}`;
  return id;
}
