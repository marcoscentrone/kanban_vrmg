/* ==========================================================================
   firebase-config.js
   --------------------------------------------------------------------------
   ESTE E O UNICO ARQUIVO QUE PRECISA SER TROCADO PARA APONTAR O KANBAN
   PARA O FIREBASE OFICIAL DA VR SOFTWARE MINAS.

   Hoje ele aponta para o projeto de TESTE "kanbanvr" (projeto pessoal,
   totalmente separado do portal https://portalvrminas.web.app).

   Para migrar no futuro, basta:
     1. substituir o objeto firebaseConfig pelas credenciais do projeto real;
     2. conferir COLECAO_CARDS (se no projeto real a colecao tiver outro nome);
     3. nao mudar mais nada em kanban.js.

   SDK modular via CDN, versao 12.19.0 - sem npm, sem bundler.
   getAnalytics NAO e usado de proposito: o Kanban nao precisa disso.
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// --- Projeto de TESTE (kanbanvr) -----------------------------------------
export const firebaseConfig = {
  apiKey: "AIzaSyDVGCNkdlU2pTctYnyGaYXa0lP_jDAJ83Y",
  authDomain: "kanbanvr.firebaseapp.com",
  projectId: "kanbanvr",
  storageBucket: "kanbanvr.firebasestorage.app",
  messagingSenderId: "45723463670",
  appId: "1:45723463670:web:36e6d760f228309ac361d7",
  measurementId: "G-J4FWHKHGLB"
};

// Nome da colecao do Firestore usada pelo quadro.
// Fica aqui (e nao em kanban.js) porque, ao integrar ao projeto da empresa,
// o nome da colecao pode precisar mudar junto com as credenciais.
export const COLECAO_CARDS = "kanban_cards";

// Cadastros da area administrativa (admin.html).
//   kanban_departamentos/{id}    -> { nome, criadoEm, atualizadoEm }
//   kanban_acessos/{email}       -> { email, departamentos: [nomes], ... }
// O e-mail e o proprio id do documento, o que impede cadastro duplicado.
export const COLECAO_DEPARTAMENTOS = "kanban_departamentos";
export const COLECAO_ACESSOS = "kanban_acessos";

// Trilha de auditoria: um documento por alteracao (quem, o que, quando).
//   kanban_auditoria/{id} -> { tarefaId, tarefaTitulo, departamento,
//                              acao, alvo, campo, de, para,
//                              porEmail, porNome, em }
export const COLECAO_AUDITORIA = "kanban_auditoria";

// Arquivo das tarefas que sairam do quadro mas continuam no relatorio:
//   cards_finalizados/{id} -> tarefa concluida (botao "Finalizar")
//   cards_cancelados/{id}  -> tarefa cancelada (antigo "Excluir")
// Guardam os mesmos campos do card + status, arquivadoEm e arquivadoPor.
export const COLECAO_FINALIZADOS = "cards_finalizados";
export const COLECAO_CANCELADOS = "cards_cancelados";

// Ambiente atual - usado so para exibir um aviso discreto na tela.
// Troque para "producao" quando apontar para o Firebase da empresa.
export const AMBIENTE = "teste";

export const app = initializeApp(firebaseConfig);

// initializeFirestore (em vez de getFirestore) para ajustar duas coisas que
// pesam muito na velocidade percebida dentro da rede da empresa:
//
// 1. localCache persistente (IndexedDB): o quadro abre na hora com os dados da
//    ultima visita e sincroniza em segundo plano, em vez de ficar em branco
//    esperando a rede. persistentMultipleTabManager permite varias abas abertas
//    compartilhando o mesmo cache - util porque testamos com 2 abas.
//
// 2. experimentalAutoDetectLongPolling: o canal de tempo real do Firestore usa
//    WebChannel/streaming, que proxies e firewalls corporativos costumam
//    segurar. Com isto o SDK detecta o bloqueio e cai para long-polling sozinho,
//    em vez de ficar tentando e dando a impressao de lentidao.
// Authentication: login com conta Google. O e-mail verificado que vem daqui e
// a chave usada em kanban_acessos para decidir o que a pessoa enxerga.
export const auth = getAuth(app);

/* ==========================================================================
   CONTROLE DE ACESSO - as duas travas que o portal da empresa ja usa
   (confirmado com o Rodrigo em 15/09/2026: "a primeira e pelo dominio,
   ninguem acessa fora do dominio; e outra por nome")

   Comecam DESLIGADAS para permitir os testes com conta pessoal.
   Para valer a regra da empresa, faca as duas coisas:

     1. preencha DOMINIOS_PERMITIDOS com o dominio corporativo
     2. troque EXIGIR_CADASTRO para true
   ========================================================================== */

// Dono do quadro: acesso total sempre, mesmo sem cadastro em kanban_acessos.
// E a garantia de nunca ficar trancado do lado de fora da propria ferramenta.
// O MESMO e-mail esta na funcao souDono() de firestore.rules - mudar aqui pede
// mudar la tambem.
export const EMAIL_DONO = "marcos.centrone@vrbelohorizonte.com.br";

// DEV / TESTE LOCAL: finge que voce e outro usuario, SO NA INTERFACE.
// Voce continua logado como voce (o Firestore usa o SEU token real), mas o
// quadro passa a se comportar como esse usuario - util para ver o acesso
// restrito por departamento sem ter uma segunda conta.
// NAO testa o bloqueio do SERVIDOR (para isso, use o Rules Playground).
// >>> Deixe null em producao. <<<
// Exemplo:
//   export const SIMULAR_USUARIO = {
//     email: "teste@vrbelohorizonte.com.br",
//     admin: false,
//     departamentos: ["COMERCIAL"]   // [] = ve todos
//   };
export const SIMULAR_USUARIO = null;

// Trava 1 - dominio. Lista VAZIA aceita qualquer conta Google (modo teste).
// Preenchida, so entram e-mails terminados nestes dominios.
export const DOMINIOS_PERMITIDOS = [
  "vrbelohorizonte.com.br",
];

// Excecoes pontuais a trava de dominio (consultores, conta de teste).
// Esvazie antes de ir para producao.
export const EMAILS_LIBERADOS = [
  // "marcos.centrone@gmail.com",
];

// MODO ABERTO (temporario, para o primeiro cadastro)
// Com true, o icone da area administrativa aparece para qualquer pessoa logada
// e a pagina admin.html abre sem exigir a flag de administrador.
//
// >>> TROQUE PARA false assim que o primeiro administrador estiver cadastrado.
// Desligado: admins/supervisores ja cadastrados. A area administrativa agora so
// abre para admin e supervisor (o dono entra sempre, pois e admin pela regra).
export const ADMIN_ABERTO = false;

// Trava 2 - cadastro. Com true, so entra quem tem documento em kanban_acessos.
// Com false, quem nao esta cadastrado entra e ve todos os departamentos.
export const EXIGIR_CADASTRO = false;

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true
});
