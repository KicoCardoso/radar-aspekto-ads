# Radar Aspekto Ads

Painel de desempenho das campanhas da Aspekto (BH e SP), publicado como página estática no
GitHub Pages. O GitHub lê a conta de anúncios na API da Meta de hora em hora, grava os números
em `public/data.json` e republica a página. Quem abre o link só vê um site — não precisa de
conta no GitHub, nem no Claude, nem acesso ao Gerenciador de Anúncios.

```
GitHub Actions (de hora em hora)
  ├─ scripts/fetch-meta.mjs   →  investimento, impressões e leads da conta de anúncios
  └─ scripts/fetch-leads.mjs  →  as respostas do formulário (sem nome, telefone ou e-mail)
       └─ public/data.json    →  os números
            └─ public/index.html  →  a página, que lê o data.json no navegador de quem abre
```

A página é gerada a partir do `dashboard.html` (o painel como ele existe no Claude):

```
node scripts/build-page.mjs dashboard.html public/index.html
```

O `build-page.mjs` troca só a camada de dados — em vez de falar com os conectores, a página
passa a ler o `data.json`. Gráficos, contas e layout continuam idênticos. Sempre que o painel
mudar, atualize o `dashboard.html` e rode esse comando de novo.

## Dado pessoal

O `data.json` é público (qualquer um que abra a página baixa esse arquivo). Por isso o
`fetch-leads.mjs` só publica respostas de múltipla escolha do formulário, e joga fora todo o
resto por duas barreiras independentes: uma lista de nomes de campo conhecidos (nome, telefone,
e-mail, CPF, endereço…) e uma regra de cardinalidade — campo cujas respostas são quase todas
diferentes é texto livre e não entra. Os nomes descartados aparecem no registro da execução.

## Como colocar no ar

### 1. Token da Meta (uma vez)

O GitHub precisa de um token próprio para ler a conta — o login do Gerenciador não serve.
Use um **usuário do sistema**, cujo token não expira quando alguém troca de senha ou sai da empresa.

1. Abra o [Meta Business Suite](https://business.facebook.com/settings) no negócio **Aspekto Saude**.
2. **Usuários → Usuários do sistema → Adicionar**. Nome: `Radar Ads`, função **Funcionário**.
3. Nesse usuário, **Adicionar ativos → Contas de anúncios →** marque **Henrique** com
   **Ver desempenho** (só leitura — o token não consegue alterar nada).
4. Ainda nesse usuário, **Adicionar ativos → Páginas →** marque **Aspekto Saude** com acesso
   aos **cadastros** (é o que permite baixar as respostas do formulário).
5. **Gerar novo token**: escolha um app do negócio, validade **nunca expira**, e marque
   **`ads_read`**, **`leads_retrieval`**, **`pages_show_list`** e **`pages_read_engagement`**.
   Copie o token; ele só aparece uma vez.

### 2. Repositório

1. Crie um repositório no GitHub (pode ser **público** — o token nunca fica nos arquivos; ele
   vive nos segredos do repositório, que não aparecem no código nem nos registros de execução).
2. Envie o conteúdo desta pasta para a branch `main`.
3. **Settings → Secrets and variables → Actions**
   - aba **Secrets** → `META_ACCESS_TOKEN` = o token do passo 1
   - aba **Variables** → `META_AD_ACCOUNT_ID` = `1545616483609687`
   - aba **Variables** → `META_PAGE_ID` = `1155805810953446`
4. **Settings → Pages → Source: GitHub Actions**.
5. **Actions → Atualizar dados e publicar → Run workflow**.

Ao terminar, o endereço aparece na própria execução e em **Settings → Pages**. É esse link que
você manda para a equipe:

```
https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/
```

## O que a equipe vê

A página sozinha, com os números da última leitura. Ela se atualiza de hora em hora; quem
estiver com a página aberta recebe os novos números sem recarregar. O carimbo da última leitura
fica no rodapé e no canto inferior do menu.

## Quem pode ver

Um link do GitHub Pages é **público**: qualquer pessoa com o endereço abre a página, e ela mostra
investimento, leads e custos. O endereço não é divulgado nem indexado (a página pede aos
buscadores que não a indexem), mas não é secreto. Se em algum momento isso não servir, dá para
fechar o repositório e o Pages para membros da organização — nesse caso o GitHub passa a pedir
login de quem abrir.

## Ajustes

| O quê | Onde |
|---|---|
| Frequência da atualização | `cron` em `.github/workflows/atualizar.yml` (`'7 * * * *'` = todo início de hora) |
| Outra conta de anúncios | variável `META_AD_ACCOUNT_ID` em Settings → Secrets and variables → Actions → Variables |
| Versão da API da Meta | variável `META_API_VERSION` (padrão `v25.0`) |
| Trocar o token | atualize o segredo `META_ACCESS_TOKEN` |
| Layout, cálculos, gráficos | `public/index.html` (gerado por `scripts/build-page.mjs`) |

## Rodando na sua máquina

```bash
META_ACCESS_TOKEN="seu-token" node scripts/fetch-meta.mjs   # gera public/data.json
node scripts/verificar-dados.mjs                            # confere o arquivo
npx serve public                                            # abre em http://localhost:3000
node --test scripts/testes.mjs                              # testes do coletor
```

Abrir `public/index.html` direto do disco (`file://`) não funciona: o navegador bloqueia a
leitura do `data.json`. Use `npx serve public` ou o próprio Pages.

## Quando algo falha

A página avisa em vez de mostrar número errado — e nunca publica por cima de uma leitura boa
uma leitura quebrada (`scripts/verificar-dados.mjs` derruba a execução antes disso).

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Aviso "os números podem estar atrasados" | as execuções pararam | Veja a aba **Actions**. O GitHub desliga agendamentos em repositórios sem commits há 60 dias — basta reativar ali |
| Execução falha com `código 190` | token expirado ou revogado | Gere outro token (passo 1) e atualize o segredo |
| Execução falha com `ads_read` / `código 200` | usuário do sistema sem a conta atribuída | Refaça o passo 1.3 |
| Página diz "Não consegui carregar os dados" | ainda não houve execução bem-sucedida | Rode o workflow manualmente e recarregue |
| Campanhas aparecem em "Outros" | nome sem as tags `[BH]`/`[SP]`, `[Formulario]`/`[Whatsapp]`, `[L1..L3]`/`[E1..E3]` | Renomeie no Gerenciador — a página classifica pelo nome |

## Arquivos

```
public/index.html              a página (não depende de nada além do data.json)
public/data.json               os números — criado pela primeira execução do workflow
scripts/fetch-meta.mjs         lê a API da Meta e grava o data.json
scripts/verificar-dados.mjs    confere o data.json antes de publicar
scripts/build-page.mjs         regenera a página a partir do dashboard original
scripts/testes.mjs             testes do coletor (sem rede, sem token)
.github/workflows/atualizar.yml  agendamento, atualização e publicação
```
