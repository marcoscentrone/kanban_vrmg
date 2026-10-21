/* ==========================================================================
   auditoria.js - Registro de quem mudou o que, e quando
   --------------------------------------------------------------------------
   Grava em kanban_auditoria/{id}:

     { tarefaId, tarefaTitulo, departamento,
       acao, alvo, campo, de, para,
       porEmail, porNome, em }

   Cada documento e UM fato: "fulano mudou o titulo de X para Y em tal dia".
   Salvar uma tarefa que teve 3 campos alterados gera 3 registros - assim a
   leitura nao precisa decifrar um diff, e dá para filtrar por campo.

   O registro e sempre feito DEPOIS da gravacao dar certo. Se a auditoria
   falhar, a operacao do usuario continua valendo: perder o historico de uma
   alteracao e ruim, mas bloquear o trabalho por causa disso e pior.
   ========================================================================== */

import { db, COLECAO_AUDITORIA } from "./firebase-config.js";
import { ESTADO_INFO } from "./subtarefas.js";
import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const refAuditoria = () => collection(db, COLECAO_AUDITORIA);

// Campos de texto acompanhados, com o rotulo que aparece na tela.
export const CAMPOS_AUDITADOS = {
  titulo: "Título",
  descricao: "Descrição",
  departamento: "Departamento",
  responsavel: "Responsável",
  prioridade: "Prioridade",
  inicioPrevisto: "Início previsto",
  fimPrevisto: "Término previsto",
  coluna: "Lista"
};

export const ACOES = {
  criou: "criou a tarefa",
  alterou: "alterou",
  excluiu: "excluiu a tarefa",
  finalizou: "finalizou a tarefa",
  cancelou: "cancelou a tarefa",
  sub_add: "adicionou a etapa",
  sub_del: "removeu a etapa",
  sub_nome: "renomeou a etapa",
  sub_estado: "mudou o estado da etapa"
};

/* -------------------------------------------------------------------------- */

function usuarioAtual(usuario) {
  return {
    porEmail: usuario && usuario.email ? usuario.email : "",
    porNome: usuario && usuario.nome ? usuario.nome : ""
  };
}

// Uma gravacao por fato. Erros vao para o console e nao interrompem nada.
async function gravar(registros) {
  if (!registros.length) return;
  try {
    await Promise.all(
      registros.map((r) => addDoc(refAuditoria(), { ...r, em: serverTimestamp() }))
    );
  } catch (e) {
    console.error("[auditoria] não foi possível registrar:", e);
  }
}

function base(card, usuario) {
  return {
    tarefaId: card.id || "",
    tarefaTitulo: card.titulo || "",
    departamento: card.departamento || "",
    // E-mail do responsavel da tarefa: usado para o usuario comum so enxergar a
    // trilha das tarefas dele (mesma regra do quadro e do relatorio).
    responsavelEmail: (card.responsavelEmail || "").toLowerCase(),
    ...usuarioAtual(usuario)
  };
}

function vazioOuTexto(v) {
  return v === undefined || v === null ? "" : String(v);
}

/* -------------------------------------------------------------------------- */
/* Eventos                                                                    */
/* -------------------------------------------------------------------------- */

export function registrarCriacao(card, usuario) {
  return gravar([{ ...base(card, usuario), acao: "criou", alvo: "tarefa", campo: "", de: "", para: card.titulo || "" }]);
}

export function registrarExclusao(card, usuario) {
  return gravar([{ ...base(card, usuario), acao: "excluiu", alvo: "tarefa", campo: "", de: card.titulo || "", para: "" }]);
}

export function registrarFinalizacao(card, usuario) {
  return gravar([{ ...base(card, usuario), acao: "finalizou", alvo: "tarefa", campo: "", de: card.titulo || "", para: "" }]);
}

export function registrarCancelamento(card, usuario) {
  return gravar([{ ...base(card, usuario), acao: "cancelou", alvo: "tarefa", campo: "", de: card.titulo || "", para: "" }]);
}

// Compara antes/depois e gera um registro por campo que mudou.
// `nomeDaLista` traduz o id da coluna para o nome que a pessoa ve.
export function registrarEdicao(antes, depois, usuario, nomeDaLista = (id) => id) {
  const registros = [];

  Object.keys(CAMPOS_AUDITADOS).forEach((campo) => {
    let de = vazioOuTexto(antes[campo]);
    let para = vazioOuTexto(depois[campo]);
    if (de === para) return;

    if (campo === "coluna") {
      de = nomeDaLista(de);
      para = nomeDaLista(para);
      if (de === para) return;
    }

    registros.push({
      ...base({ ...depois, id: antes.id }, usuario),
      acao: "alterou",
      alvo: "tarefa",
      campo,
      de,
      para
    });
  });

  registros.push(...diffSubtarefas(antes, depois, usuario));
  return gravar(registros);
}

// Etapas adicionadas, removidas, renomeadas ou com estado trocado.
// A comparacao e por id: so assim "renomear" nao vira "apagou + criou".
export function diffSubtarefas(antes, depois, usuario) {
  const registros = [];
  const b = base({ ...depois, id: antes.id }, usuario);

  const deAntes = new Map((antes.subtarefas || []).map((s) => [s.id, s]));
  const deDepois = new Map((depois.subtarefas || []).map((s) => [s.id, s]));

  // removidas
  deAntes.forEach((sub, id) => {
    if (!deDepois.has(id)) {
      registros.push({ ...b, acao: "sub_del", alvo: "subtarefa", campo: "", de: sub.nome, para: "" });
    }
  });

  // adicionadas e alteradas
  deDepois.forEach((sub, id) => {
    const anterior = deAntes.get(id);

    if (!anterior) {
      registros.push({ ...b, acao: "sub_add", alvo: "subtarefa", campo: "", de: "", para: sub.nome });
      return;
    }
    if (anterior.nome !== sub.nome) {
      registros.push({ ...b, acao: "sub_nome", alvo: "subtarefa", campo: "nome", de: anterior.nome, para: sub.nome });
    }
    if (anterior.estado !== sub.estado) {
      registros.push({
        ...b,
        acao: "sub_estado",
        alvo: "subtarefa",
        campo: sub.nome,
        de: (ESTADO_INFO[anterior.estado] || {}).rotulo || anterior.estado,
        para: (ESTADO_INFO[sub.estado] || {}).rotulo || sub.estado
      });
    }
  });

  return registros;
}

// Atalho para o clique direto no card, que muda so o estado de uma etapa.
export function registrarEstadoSubtarefa(card, sub, estadoAntes, estadoDepois, usuario) {
  return gravar([{
    ...base(card, usuario),
    acao: "sub_estado",
    alvo: "subtarefa",
    campo: sub.nome,
    de: (ESTADO_INFO[estadoAntes] || {}).rotulo || estadoAntes,
    para: (ESTADO_INFO[estadoDepois] || {}).rotulo || estadoDepois
  }]);
}

// Movimentacao entre listas (arrastar ou setas), fora do modal.
export function registrarMovimento(card, listaAntes, listaDepois, usuario) {
  return gravar([{
    ...base(card, usuario),
    acao: "alterou",
    alvo: "tarefa",
    campo: "coluna",
    de: listaAntes,
    para: listaDepois
  }]);
}

/* -------------------------------------------------------------------------- */
/* Leitura                                                                    */
/* -------------------------------------------------------------------------- */

// Frase pronta do que aconteceu, usada na tela de auditoria.
export function descrever(reg) {
  const rotuloCampo = CAMPOS_AUDITADOS[reg.campo] || reg.campo;

  switch (reg.acao) {
    case "criou":      return `criou a tarefa "${reg.para}"`;
    case "excluiu":    return `excluiu a tarefa "${reg.de}"`;
    case "finalizou":  return `finalizou a tarefa "${reg.de}"`;
    case "cancelou":   return `cancelou a tarefa "${reg.de}"`;
    case "sub_add":    return `adicionou a etapa "${reg.para}"`;
    case "sub_del":    return `removeu a etapa "${reg.de}"`;
    case "sub_nome":   return `renomeou a etapa "${reg.de}" para "${reg.para}"`;
    case "sub_estado": return `marcou a etapa "${reg.campo}" como ${reg.para}`;
    case "alterou":
      if (!reg.de) return `preencheu ${rotuloCampo} com "${reg.para}"`;
      if (!reg.para) return `limpou ${rotuloCampo} (era "${reg.de}")`;
      return `alterou ${rotuloCampo} de "${reg.de}" para "${reg.para}"`;
    default:
      return reg.acao;
  }
}
