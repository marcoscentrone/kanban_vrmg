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
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true
});
