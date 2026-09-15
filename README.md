# Quadro de Fluxo — Kanban VR Software Minas

Kanban interno em **HTML + CSS + JavaScript puro** (sem framework, sem build tool),
com **Cloud Firestore** em tempo real (`onSnapshot`) — mesma stack do portal
`portalvrminas.web.app`.

> **Ambiente isolado.** Este projeto usa o Firebase de teste **`kanbanvr`**,
> separado do Firebase oficial da empresa. Nada aqui toca o projeto real.

---

## Estrutura

```
Projeto_Kambam/
├── index.html              Marcação do quadro + modal de tarefa
├── css/
│   └── kanban.css          Estilo (identidade VR: laranja #FF7200 + Montserrat)
├── js/
│   ├── firebase-config.js  ÚNICO arquivo a trocar na migração
│   └── kanban.js           Render, drag & drop e CRUD no Firestore
├── firestore.rules         Regras do ambiente de teste
└── README.md
```

---

## Modelo de dados — coleção `kanban_cards`

Um documento por tarefa (id gerado pelo Firestore via `addDoc`):

| Campo          | Tipo      | Descrição |
|----------------|-----------|-----------|
| `titulo`       | string    | Título da tarefa (obrigatório) |
| `descricao`    | string    | Detalhes, opcional |
| `coluna`       | string    | Id da coluna: `backlog` (exibida como "Demanda"), `analise`, `fazendo`, `aguardando`, `testando`, `finalizado` |
| `departamento` | string    | Ex.: Suporte, Implantação, Desenvolvimento… (lista em `kanban.js`) |
| `responsavel`  | string    | Nome de quem toca a tarefa (gera as iniciais do avatar) |
| `prioridade`   | string    | `baixa` \| `media` \| `alta` (define a cor da borda esquerda) |
| `inicioPrevisto` | string  | Projeção de início, `"AAAA-MM-DD"` (ou `""`) |
| `fimPrevisto`  | string    | Projeção de término, `"AAAA-MM-DD"` (ou `""`) — fica vermelho no card se já passou |
| `finalizadoEm` | timestamp | Quando entrou em *Finalizado* (base da retenção de 30 dias); `null` se for reaberta |
| `criadoEm`     | timestamp | `serverTimestamp()` |
| `atualizadoEm` | timestamp | `serverTimestamp()` |
| `criadoPor`    | string    | Nome digitado em "Você é" |

**Ordenação:** não existe ordem manual. Dentro de cada coluna os cards se
organizam sozinhos por urgência — os mais perto do término previsto no topo, os
folgados abaixo, e os **sem data de término sempre por último** (entre si, do
mais antigo para o mais novo). Arrastar um card só muda a *coluna*; a posição é
sempre consequência do prazo e se reorganiza quando alguém edita uma data ou o
dia vira. Em *Finalizado* não há urgência: vale a ordem de criação.

**Retenção das concluídas:** uma tarefa movida para *Finalizado* ganha o carimbo
`finalizadoEm`. Durante 30 dias o card mostra `⏳ sai em N dias`; passado o prazo
ele passa a exibir `🗑 liberada para exclusão` e surge no rodapé da coluna o
botão **Limpar N concluídas**, que qualquer pessoa pode usar (apaga em
`writeBatch`, com confirmação). Nada é apagado automaticamente — a exclusão é
sempre uma ação de alguém. O prazo fica em `DIAS_RETENCAO`, em `js/kanban.js`.
Mover a tarefa de volta para outra coluna zera a contagem.

As **colunas não ficam no Firestore** — são fixas em `js/kanban.js` (`COLUNAS`),
porque mudam raramente e assim o quadro abre já desenhado.

---

## Como rodar localmente

O projeto usa `<script type="module">`, e módulos ES são bloqueados pela política
de CORS quando a página é aberta via `file://`. **Abrir o `index.html` com dois
cliques não funciona** — é preciso um servidor HTTP local (qualquer um serve).

### Opção 1 — `servir.bat` (mais simples)
Dois cliques em **`servir.bat`** na raiz do projeto: ele sobe o servidor com o
Python e já abre `http://localhost:5500` no navegador. Para parar, feche a
janela preta.

### Opção 2 — Python na mão
```powershell
cd "G:\Meu Drive\Migracao\Programacao\Projeto_Kambam"
python -m http.server 5500
```
Depois abra `http://localhost:5500`.

### Opção 3 — VS Code + Live Server (se quiser instalar)
1. Extensões (`Ctrl+Shift+X`) → **Live Server** (Ritwick Dey) → Instalar.
2. Botão direito em `index.html` → **Open with Live Server**.

### Opção 4 — Firebase CLI (se um dia instalar o Node)
```powershell
firebase serve --only hosting
```

### Testando o tempo real
Abra a mesma URL em **duas abas** (ou em dois navegadores) lado a lado. Crie,
edite ou arraste um card em uma: a outra atualiza sozinha, sem recarregar —
é o `onSnapshot` trabalhando, igual às telas de Inventário e Chamados do portal.

---

## Antes do primeiro uso: liberar o Firestore

> Já feito no projeto `kanbanvr` (14/09/2026). Fica registrado para quando o
> quadro for apontado para outro projeto Firebase.

No [Firebase Console](https://console.firebase.google.com/project/kanbanvr/firestore):

1. **Firestore Database** → **Criar banco de dados** (isso ativa a API).
   Escolha a região `southamerica-east1` (São Paulo) e o modo de teste.
2. Aba **Regras** → colar o conteúdo de `firestore.rules` → **Publicar**.

A coleção `kanban_cards` **não precisa ser criada à mão** — ela nasce no primeiro
`addDoc`, quando você salvar a primeira tarefa.

Se o quadro mostrar *"Não foi possível ler o quadro (permission-denied)"*, o que
falta são as regras acima.

---

## Migrar para o Firebase da empresa (depois)

Toda a amarração com o Firebase está em **`js/firebase-config.js`**. Para apontar
o Kanban para o projeto real, mexa só nele:

1. Substituir o objeto `firebaseConfig` pelas credenciais do projeto da VR.
2. Conferir `COLECAO_CARDS` (caso lá a coleção tenha outro nome).
3. Trocar `AMBIENTE` de `"teste"` para `"producao"` (some o aviso na tela).

`js/kanban.js` **não precisa de nenhuma alteração**.

Na hora de plugar o **Firebase Authentication** do portal, o único ponto a mudar
é o campo "Você é": hoje o nome fica no `localStorage` (seção 9 de `kanban.js`);
basta trocar pelo `displayName` do usuário logado e apertar as regras do
Firestore para `request.auth != null`.

---

## Notas

- SDK Firebase **12.19.0**, modular, via CDN `gstatic` — sem npm, sem bundler.
- `getAnalytics` não é usado de propósito: o Kanban não precisa.
- O antigo botão "Atualizar" do protótipo virou um indicador **● ao vivo**: com
  `onSnapshot` não existe mais recarregar o quadro na mão.
