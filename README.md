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
├── index.html              Quadro: colunas, cards, modal de tarefa
├── admin.html              Área administrativa: departamentos e acessos
├── css/
│   ├── kanban.css          Estilo base (laranja #FF7200 + Montserrat)
│   ├── admin.css           Painéis de cadastro
│   └── auth.css            Tela de login e barra do usuário
├── js/
│   ├── firebase-config.js  ÚNICO arquivo a trocar na migração
│   ├── auth.js             Login Google + leitura de permissões
│   ├── colunas.js          Listas de cada departamento (fluxo padrão, ids)
│   ├── subtarefas.js       Etapas dentro da tarefa e o roteiro padrão
│   ├── kanban.js           Render, drag & drop e CRUD das tarefas
│   └── admin.js            CRUD de departamentos, listas e acessos
├── firestore.rules         Regras do Firestore
├── servidor.py             Servidor local sem cache
├── servir.bat              Atalho: sobe o servidor e abre o navegador
└── README.md
```

---

## Modelo de dados — coleção `kanban_cards`

Um documento por tarefa (id gerado pelo Firestore via `addDoc`):

| Campo          | Tipo      | Descrição |
|----------------|-----------|-----------|
| `titulo`       | string    | Título da tarefa (obrigatório) |
| `descricao`    | string    | Detalhes, opcional |
| `coluna`       | string    | **Id** da lista dentro do fluxo do departamento (nunca o nome) |
| `departamento` | string    | Nome do departamento dono do quadro (cadastrado em `kanban_departamentos`) |
| `responsavel`  | string    | Para quem a tarefa foi direcionada. Vem preenchido com o nome de quem cria, mas é editável — **restrito aos nomes cadastrados** em `kanban_acessos`, sugeridos conforme se digita |
| `prioridade`   | string    | `baixa` \| `media` \| `alta` (define a cor da borda esquerda) |
| `inicioPrevisto` | string  | Projeção de início, `"AAAA-MM-DD"` (ou `""`) |
| `fimPrevisto`  | string    | Projeção de término, `"AAAA-MM-DD"` (ou `""`) — fica vermelho no card se já passou |
| `finalizadoEm` | timestamp | Quando entrou em *Finalizado* (base da retenção de 30 dias); `null` se for reaberta |
| `criadoEm`     | timestamp | `serverTimestamp()` |
| `atualizadoEm` | timestamp | `serverTimestamp()` |
| `subtarefas`   | array     | Etapas da tarefa: `[{ id, nome, estado }]`, até 6. `estado`: `pendente` \| `fazendo` \| `feito` |
| `criadoPor`    | string    | E-mail de quem criou — **dono da tarefa**, o único que pode excluí-la |

**Ordenação:** não existe ordem manual. Dentro de cada coluna os cards se
organizam sozinhos por urgência — os mais perto do término previsto no topo, os
folgados abaixo, e os **sem data de término sempre por último** (entre si, do
mais antigo para o mais novo). Arrastar um card só muda a *coluna*; a posição é
sempre consequência do prazo e se reorganiza quando alguém edita uma data ou o
dia vira. Em *Finalizado* não há urgência: vale a ordem de criação.

**Responsável:** só aceita nomes que existam em `kanban_acessos` — para
direcionar a tarefa a alguém novo, cadastre a pessoa antes na área
administrativa. Duas exceções, para não travar o uso: o nome que já estava
gravado numa tarefa antiga continua aceito (senão seria impossível editar os
outros campos dela), e se a lista de cadastrados não carregar o campo volta a
ser livre, em vez de bloquear o quadro por um erro de permissão. O campo pode
ficar vazio (tarefa sem responsável definido).

**Dono x responsável:** `criadoPor` é o dono — ele e os **administradores** veem o
botão *Excluir tarefa*.
`responsavel` é quem deve executar, e qualquer pessoa pode alterá-lo. Tarefas sem dono registrado (as criadas antes do
login, que guardaram texto livre como "anônimo" em vez de um e-mail) podem ser
excluídas por qualquer um, senão ficariam impossíveis de limpar. A exceção é a limpeza das concluídas: passados os 30 dias,
qualquer pessoa pode remover, independente de quem criou.

**Retenção das concluídas:** uma tarefa movida para *Finalizado* ganha o carimbo
`finalizadoEm`. Durante 30 dias o card mostra `⏳ sai em N dias`; passado o prazo
ele passa a exibir `🗑 liberada para exclusão` e surge no rodapé da coluna o
botão **Limpar N concluídas**, que qualquer pessoa pode usar (apaga em
`writeBatch`, com confirmação). Nada é apagado automaticamente — a exclusão é
sempre uma ação de alguém. O prazo fica em `DIAS_RETENCAO`, em `js/kanban.js`.
Mover a tarefa de volta para outra coluna zera a contagem.

**Listas por departamento:** cada departamento tem seu próprio fluxo, cadastrado
na área administrativa e guardado em `kanban_departamentos/{id}.colunas` como
`[{ id, nome }]`, no máximo **6**. O quadro trabalha sempre dentro de **um**
departamento (o seletor do topo não tem "Todos"), porque fluxos diferentes não
cabem lado a lado. Departamento sem listas próprias usa `COLUNAS_PADRAO`
(`js/colunas.js`), que mantém os ids antigos para não orfanar tarefas.

O campo `coluna` da tarefa guarda o **id** da lista, nunca o nome — por isso
renomear uma lista não move nenhuma tarefa. Excluir uma lista é bloqueado
enquanto houver tarefas nela.

**Subtarefas:** a hierarquia é *departamento → lista → tarefa → subtarefa*. Cada
departamento pode ter um **roteiro padrão** (`subtarefasPadrao`), cadastrado na
área administrativa; toda tarefa criada ali já nasce com essas etapas copiadas
para dentro de si. A cópia é proposital — mudar o roteiro depois **não** altera
tarefas existentes, que já podem ter etapas concluídas.

Cada etapa tem três estados, e um clique no card avança para o próximo:
`○ a fazer → ◑ fazendo → ✓ feito`. O card mostra o progresso (`2/3`) e fica
esverdeado quando todas terminam. No modal dá para renomear, reordenar pela
remoção/adição, mudar estado e apagar etapas daquela tarefa específica.

---

## Login e permissões

O acesso é por **conta Google** (Firebase Authentication). O e-mail autenticado
é a chave que liga a pessoa ao que ela pode ver.

### `kanban_departamentos/{id}`
| Campo | Tipo | Descrição |
|---|---|---|
| `nome` | string | CAIXA ALTA sem acentos (conversão automática no cadastro) |
| `colunas` | array | Fluxo do departamento: `[{ id, nome }]`, até 6. Vazio = usa o padrão |
| `subtarefasPadrao` | array | Nomes das etapas que toda tarefa nova do departamento recebe, até 6 |
| `criadoEm` / `atualizadoEm` | timestamp | `serverTimestamp()` |

As tarefas guardam o **nome** do departamento, não um id. Por isso renomear um
departamento propaga em lote (`writeBatch`) para todas as tarefas e acessos que
o usavam, e excluir é bloqueado enquanto houver tarefas usando.

### `kanban_acessos/{email}`
| Campo | Tipo | Descrição |
|---|---|---|
| `email` | string | Minúsculo; é também o **id do documento**, o que impede duplicata |
| `departamentos` | array | Nomes que a pessoa enxerga. **Vazio = vê tudo** |
| `admin` | bool | Acesso total: abre `admin.html`, vê todos os departamentos e exclui qualquer tarefa |
| `criadoEm` / `atualizadoEm` | timestamp | `serverTimestamp()` |

Regra de visibilidade: com a lista de departamentos vazia, a pessoa vê todas as
tarefas. Quem não tem cadastro só consegue entrar enquanto `EXIGIR_CADASTRO`
estiver desligado (veja abaixo). Com
departamentos marcados, vê só os deles (mais as tarefas sem departamento, que
ficam visíveis a todos para poderem ser classificadas).

### Duas travas de acesso

O portal da empresa usa duas barreiras (confirmado com o Rodrigo em 15/09/2026:
*"a primeira é pelo domínio, ninguém acessa fora do domínio; e outra por nome"*).
O Kanban segue a mesma estrutura, em **`js/firebase-config.js`**:

```js
// Dono do quadro: acesso total sempre, sem depender de cadastro.
// O MESMO e-mail está em souDono(), em firestore.rules.
export const EMAIL_DONO = "marcos.centrone@vrbelohorizonte.com.br";

// Trava 1 — domínio (ATIVA). Lista vazia aceitaria qualquer conta Google.
export const DOMINIOS_PERMITIDOS = ["vrbelohorizonte.com.br"];

// Exceções pontuais (consultor, conta de teste). Esvazie em produção.
export const EMAILS_LIBERADOS = [];

// Modo aberto — TEMPORÁRIO, para o primeiro cadastro.
export const ADMIN_ABERTO = true;   // <- false depois do 1º administrador

// Trava 2 — cadastro. true = só entra quem está em kanban_acessos.
export const EXIGIR_CADASTRO = false;
```

**Checklist para fechar o ambiente**, depois de cadastrar a equipe:

1. `ADMIN_ABERTO` → `false` (o ícone ⚙ volta a aparecer só para administradores)
2. `EXIGIR_CADASTRO` → `true` (só entra quem está em `kanban_acessos`)
3. Em `firestore.rules`, `modoAberto()` → `return false;` e republicar

Quem for barrado vê a explicação na tela de login, em vez de uma página quebrada.

### Primeiro acesso
Enquanto **nenhum** administrador existir, o primeiro usuário autenticado
consegue abrir `admin.html` e se cadastrar como administrador — senão o cadastro
nasceria trancado. Depois disso, **endureça a regra**: veja o aviso em
`firestore.rules`, na seção `kanban_acessos`.

### Ativar no Firebase Console
Nesta ordem — publicar as regras antes de ativar o login tranca todo mundo:

1. **Authentication → Sign-in method → Google → Ativar** (escolha um e-mail de
   suporte do projeto).
2. **Authentication → Settings → Authorized domains**: `localhost` já vem na
   lista. Adicione o domínio de produção quando publicar.
3. Testar o login em `http://localhost:5500`.
4. Só então colar `firestore.rules` em **Firestore → Regras** e publicar.

> **O que as regras garantem e o que não garantem.** Elas exigem conta Google
> autenticada para ler ou escrever qualquer coisa — o essencial. O recorte por
> departamento, porém, acontece hoje **na tela**: organiza o trabalho, mas não
> impede alguém técnico de ler todas as tarefas pelo console do navegador. Para
> virar barreira de verdade é preciso trocar o `onSnapshot` da coleção inteira
> por uma query `where("departamento", "in", [...])` e ligar a regra comentada
> em `firestore.rules` — porque as regras do Firestore **validam** a consulta,
> não filtram resultados.

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
