#!/usr/bin/env node
/**
 * Gera public/index.html a partir do dashboard original (o artifact do Claude),
 * trocando a camada de dados: em vez de falar com o conector do claude.ai, a
 * página passa a ler o arquivo ./data.json publicado junto com ela.
 *
 *   node scripts/build-page.mjs ../aspekto-radar/index.html public/index.html
 *
 * Só a camada de dados muda — gráficos, cálculos e layout continuam idênticos.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const src = process.argv[2] || '../aspekto-radar/index.html';
const dest = process.argv[3] || 'public/index.html';

let html = await readFile(src, 'utf8');

/* 0. o arquivo salvo do artifact vem embrulhado no esqueleto que o visualizador acrescenta
      (doctype, head e body próprios). Tiramos esse embrulho: o head e o body desta página
      são montados no passo 1, com as fontes, o ícone e os ajustes de largura. */
{
  const t = html.indexOf('<title>Radar Aspekto Ads</title>');
  if (t > 0 && /^\s*<!doctype/i.test(html.slice(0, 40))) html = html.slice(t);
  html = html.replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
}

function replaceOnce(needle, replacement, label) {
  const i = html.indexOf(needle);
  if (i === -1) throw new Error('não encontrei o trecho: ' + label);
  if (html.indexOf(needle, i + 1) !== -1) throw new Error('trecho ambíguo: ' + label);
  html = html.slice(0, i) + replacement + html.slice(i + needle.length);
}

/* 1. documento HTML completo (o artifact não tinha <head>/<body>) */
replaceOnce('<title>Radar Aspekto Ads</title>', `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="Painel de desempenho das campanhas da Aspekto (BH e SP).">
<title>Radar Aspekto Ads</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%A1%3C/text%3E%3C/svg%3E">`, 'title/head');
/* 1b. celular: sem o contêiner do artifact, as faixas em grade empurravam a página para o lado
       (itens de grid têm min-width:auto). Prende cada faixa à largura da tela e deixa o menu e
       as tabelas rolarem por dentro. */
replaceOnce('</style>\n', `  /* O visualizador de artifacts embrulha a página num documento que traz
     [hidden]{display:none!important}. Aqui esse embrulho não existe, e regras como
     .btn{display:inline-flex} venciam o estilo padrão do navegador — elementos marcados
     como hidden apareciam mesmo assim (era o caso do botão "trocar planilhas"). */
  [hidden]:not([hidden="until-found" i]) { display: none !important; }

  /* --- ajuste de largura fora do visualizador de artifacts --- */
  html, body { max-width: 100%; overflow-x: hidden; }
  .app, .app > *, .main, .wrap, section, .card, .charts, .charts > *, .kpis, .tiles, .tscroll { min-width: 0; }
  .side { max-width: 100%; }
  @media (max-width: 1024px) {
    .side { -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
    .side nav { flex: 1 1 auto; min-width: 0; }
  }
  /* números grandes cabem na coluna estreita do celular em vez de serem cortados */
  @media (max-width: 760px) {
    .kpi .val { font-size: 21px; }
    .kpi.hl .val { font-size: 25px; }
    .kpi.hl { margin: -8px 2px; padding: 12px 14px; }
    .tile .val { font-size: 22px; }
  }
  @media (max-width: 420px) {
    .kpi .val, .kpi.hl .val, .tile .val { font-size: 19px; }
  }
</style>
</head>
<body>
`, 'abertura do body e ajuste de largura');
html = html.replace(/<\/script>\s*$/, '</script>\n</body>\n</html>\n');

/* 2. conversas: o data.json traz o número exato, sem precisar derivar do custo por conversa */
replaceOnce("    let conv = derived(spend, cpc);",
  "    let conv = e.conversations != null && e.conversations !== '' ? parseNum(e.conversations) : derived(spend, cpc);", 'conversas');

/* 3. rodapé: a fonte agora é a API da Meta, não o conector */
replaceOnce('<div><b>Fonte.</b> Conector Facebook Ads da sua conta claude.ai, lido com as suas credenciais. Os números da Meta podem levar algumas horas para consolidar; o dia atual é sempre parcial.</div>',
  '<div><b>Fonte.</b> API de Marketing da Meta (conta Henrique), lida automaticamente de hora em hora e publicada nesta página. Os números da Meta podem levar algumas horas para consolidar; o dia atual é sempre parcial. <span id="srcStamp"></span></div>', 'rodapé fonte');

/* 4. atualização: de 5 min (conector) para de hora em hora (GitHub Actions);
      e o bloco "Hoje" passa a se referir ao horário da leitura, não ao relógio de quem abre */
replaceOnce("monthName(S.range.since).toLowerCase() + ' · atualiza a cada 5 min'",
  "monthName(S.range.since).toLowerCase() + ' · atualiza de hora em hora'", 'subtítulo');
replaceOnce('<span class="note" id="todayNote">até agora · atualiza a cada 5 min</span>',
  '<span class="note" id="todayNote">atualiza de hora em hora</span>', 'nota do bloco Hoje');
replaceOnce("    const now = new Date(); const hourFrac = Math.max(0.02, (now.getHours() + now.getMinutes() / 60) / 24);",
  "    const now = dataNow(); const hourFrac = Math.max(0.02, (now.getHours() + now.getMinutes() / 60) / 24);", 'relógio do bloco Hoje');
replaceOnce("    $('todayNote').textContent = 'até ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ' · atualiza a cada 5 min';",
  "    $('todayNote').textContent = 'até ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ' · atualiza de hora em hora';", 'hora do bloco Hoje');
// dataNow(): o instante da leitura publicada (o ritmo do dia é medido por ele, não pelo relógio do visitante)
replaceOnce("  /* ---------------- rendering: today ---------------- */",
  "  const dataNow = () => S.at ? new Date(S.at) : new Date();\n\n  /* ---------------- rendering: today ---------------- */", 'helper dataNow');
replaceOnce("    model: null, accessDenied: false, offline: false,",
  "    model: null, accessDenied: false, offline: false, at: null,", 'campo at no estado');

/* 4b. estados vazios e instruções de reconectar o conector não fazem mais sentido aqui */
html = html.split("S.offline ? 'Sem conexão com o conector.' :").join("S.offline ? 'Dados indisponíveis.' :");
const stepsStart = html.indexOf('  const ACCESS_STEPS = [');
const stepsEnd = html.indexOf('];', stepsStart);
if (stepsStart === -1 || stepsEnd === -1) throw new Error('não encontrei ACCESS_STEPS');
html = html.slice(0, stepsStart) + html.slice(stepsEnd + 3);

/* 5. camada de dados: troca watches do conector pela leitura do data.json */
const cutStart = html.indexOf('  /* ---------------- watches ---------------- */');
const cutEnd = html.indexOf('  /* ---------------- controls ---------------- */');
if (cutStart === -1 || cutEnd === -1) throw new Error('não encontrei a camada de dados');
html = html.slice(0, cutStart) + `  /* ---------------- dados (arquivo data.json publicado junto com a página) ---------------- */
  const DATA_URL = 'data.json';
  const KEYS = ['campaigns', 'adsets', 'ads', 'daily', 'prev', 'today', 'plat'];

  function applyData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.campaigns)) throw new Error('formato inesperado');
    if (data.range && data.range.since && data.range.until) S.range = data.range;
    for (const k of KEYS) S.raw[k] = data[k] ? { ad_entities: data[k] } : null;
    const parsed = data.generatedAt ? new Date(data.generatedAt) : new Date();
    const stamp = isFinite(parsed.getTime()) ? parsed.getTime() : Date.now();
    const at = new Date(stamp);
    S.at = stamp;
    for (const k of KEYS) if (S.raw[k]) S.stamp[k] = stamp;
    applyLeads(data.leads);
    S.offline = false;
    document.querySelectorAll('section').forEach(s => s.classList.remove('stale'));
    banner(null);
    setLive(stale(stamp) ? 'wait' : 'on', 'atualizado');
    greet();
    renderAll();
    const el = $('srcStamp');
    if (el) el.textContent = 'Leitura de ' + at.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + '.';
    if (stale(stamp)) banner('warning', 'Estes números podem estar atrasados', 'A última leitura da Meta foi em ' + at.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ', há mais de 3 horas. A atualização automática roda de hora em hora — se continuar assim, verifique a aba Actions do repositório no GitHub.');
  }
  const stale = (ts) => Date.now() - ts > 3 * 60 * 60 * 1000;

  /* ---------------- respostas do formulário (vêm no mesmo data.json) ---------------- */
  // O coletor manda só as respostas de múltipla escolha, sem nome, telefone ou e-mail.
  // Aqui elas viram a mesma tabela que a planilha do Google entregava no painel interno,
  // para que o resto da página (score, faixas, Facebook × Instagram) não mude.
  function leadsCsv(L) {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['created_time', 'platform', 'campaign_name'].concat(L.fields || []);
    const lines = [head.map(q).join(',')];
    for (const r of L.rows || []) {
      const camp = (L.campaigns || [])[r[2]] || '';
      lines.push([r[0], r[1], camp].concat(r[3] || []).map(q).join(','));
    }
    return lines.join('\\n');
  }
  function applyLeads(L) {
    S.leads.cfg = { sheets: [] };
    S.leads.src = {}; S.leads.loading = false; S.leads.info = L || null;
    if (!L || !Array.isArray(L.rows) || !(L.fields || []).length) {
      S.leads.rows = null; S.leads.meta = null;
      S.leads.err = { message: 'O arquivo de dados ainda não traz as respostas do formulário. A coleta roda junto com a atualização de hora em hora — se continuar assim, verifique a aba Actions do repositório no GitHub.' };
      return;
    }
    const parsed = parseSheet(leadsCsv(L));
    S.leads.rows = parsed.rows; S.leads.meta = parsed.meta; S.leads.stamp = S.at || Date.now();
    S.leads.err = parsed.meta.fatal ? { message: parsed.meta.fatal } : null;
  }

  async function load() {
    setLive('wait', 'carregando');
    document.querySelectorAll('section').forEach(s => s.classList.add('stale'));
    const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyData(await res.json());
  }

  /* ---------------- controls ---------------- */` + html.slice(cutEnd + '  /* ---------------- controls ---------------- */'.length);

/* 6. botão Atualizar: relê o arquivo em vez de invalidar o cache do conector */
replaceOnce(`  $('refreshBtn').addEventListener('click', async () => {
    const b = $('refreshBtn'); b.disabled = true; b.textContent = '↻ Atualizando…';
    S.retries = {};
    try { if (S.mcp) await S.mcp.invalidate(SERVER, 'ads_get_ad_entities'); } catch (e) {}
    setTimeout(() => { b.disabled = false; b.textContent = '↻ Atualizar'; }, 2500);
  });`, `  $('refreshBtn').addEventListener('click', async () => {
    const b = $('refreshBtn'); b.disabled = true; b.textContent = '↻ Atualizando…';
    try { await load(); } catch (e) { console.warn('refresh', e); failed(e); }
    b.disabled = false; b.textContent = '↻ Atualizar';
  });`, 'botão atualizar');

/* 6b. o bloco de lead score deixa de falar em planilha do Google: aqui as respostas
      chegam pelo mesmo data.json, coletadas da API da Meta pelo scripts/fetch-leads.mjs */

replaceOnce("    btn.hidden = !cfg;", "    btn.hidden = true;", 'esconde o botão de trocar planilhas');

replaceOnce("    if (!cfg) { note.textContent = 'planilhas ainda não escolhidas'; el.innerHTML = setupCard(); clear(); return; }",
  "    if (!cfg) { note.textContent = 'sem dados de formulário'; el.innerHTML = '<div class=\"empty\">Aguardando a primeira coleta de leads.</div>'; clear(); return; }", 'sem configuração');

replaceOnce("      note.textContent = 'erro ao ler a planilha';", "      note.textContent = 'respostas indisponíveis';", 'nota de erro');
replaceOnce("<h3>Não consegui ler a planilha</h3>", "<h3>As respostas do formulário ainda não chegaram</h3>", 'título do erro');
replaceOnce("' + esc(sheetErrText(S.leads.err)) + '", "' + esc(S.leads.err.message || '') + '", 'texto do erro');

replaceOnce("    if (!S.leads.rows) { note.textContent = 'lendo a planilha…'; el.innerHTML = '<div class=\"empty\">Lendo a planilha de leads…</div>' + sheetStatusHtml(); clear(); return; }",
  "    if (!S.leads.rows) { note.textContent = 'carregando…'; el.innerHTML = '<div class=\"empty\">Carregando as respostas do formulário…</div>' + sheetStatusHtml(); clear(); return; }", 'estado de carregamento');

replaceOnce("(M.total ? ' · ' + int(M.total) + ' na' + (S.leads.cfg.sheets.length > 1 ? 's planilhas' : ' planilha') : '')",
  "(M.total ? ' · ' + int(M.total) + ' coletados' : '')", 'contagem no cabeçalho');

replaceOnce("(S.leads.cfg ? (S.leads.err ? 'A planilha de leads não pôde ser lida — veja a seção acima.' : 'Lendo a planilha de leads…') : 'Escolha as planilhas de leads na seção acima para separar Facebook e Instagram por lead score.')",
  "(S.leads.err ? 'As respostas do formulário não puderam ser lidas — veja a seção acima.' : 'Carregando as respostas do formulário…')", 'estado vazio do Facebook x Instagram');

replaceOnce('<span class="note">investimento vindo da Meta · leads e lead score vindos da planilha do formulário</span>',
  '<span class="note">investimento e respostas do formulário vindos da Meta</span>', 'nota da seção de plataformas');

replaceOnce('Vem das respostas do formulário, lidas das planilhas do Google.',
  'Vem das respostas do formulário, lidas automaticamente na API da Meta. Só as respostas de múltipla escolha são publicadas nesta página: nome, telefone e e-mail não saem da Meta.', 'rodapé do lead score');

replaceOnce('Os leads e o score vêm da planilha, pela coluna de plataforma do lead.',
  'Os leads e o score vêm das respostas do formulário, pela plataforma que a Meta registra em cada lead.', 'rodapé de plataformas');

replaceOnce('Cada planilha precisa estar acessível para a conta do Google ligada ao claude.ai.',
  'Nesta página publicada as respostas chegam prontas no arquivo de dados.', 'texto do cartão de configuração');

/* 6c. fora do claude.ai não existe conector do Google Drive nem janela extra de
      posicionamento: o bloco inteiro de configuração de planilhas sai e a leitura por
      posicionamento passa a ser a que já veio no data.json. */
const sheetsStart = html.indexOf('  /* ---------------- lead score: config (which sheets) ---------------- */');
const sheetsEnd = html.indexOf('  /* ---------------- lead score: model ---------------- */');
if (sheetsStart === -1 || sheetsEnd === -1) throw new Error('não encontrei o bloco de configuração de planilhas');
html = html.slice(0, sheetsStart) + `  /* ---------------- lead score: origem dos dados ---------------- */
  // Quais formulários entraram na conta, e o lembrete de que nada pessoal é publicado.
  function sheetStatusHtml() {
    const L = S.leads.info; if (!L) return '';
    const forms = (L.forms || []).filter((f) => f.count || f.error);
    return '<div class="qcols"><span>respostas lidas direto da Meta, sem nome nem telefone</span>' +
      forms.map((f) => f.error
        ? '<span style="color:var(--critical-ink)">' + esc(f.name) + ': ' + esc(f.error) + '</span>'
        : '<span>' + esc(f.name) + ': <b style="color:var(--ink-2)">' + int(f.count) + '</b></span>').join('') +
      '</div>';
  }

` + html.slice(sheetsEnd);

replaceOnce(`  // the placement breakdown for that same window, when it has already been read
  function ensurePlatWindow(since) {
    if (!S.mcp || !S.range) return;
    const until = S.range.until;
    if (!since) {
      if (S.platWin.unsub) { try { S.platWin.unsub(); } catch (e) {} }
      S.platWin = { since: null, until: null, unsub: null }; S.raw.platWin = null; return;
    }
    if (S.platWin.since === since && S.platWin.until === until) return;
    if (S.platWin.unsub) { try { S.platWin.unsub(); } catch (e) {} }
    S.raw.platWin = null;
    const spec = baseInput({ level: 'campaign', time_range: tr(since, until), fields: F_PLAT, breakdowns: ['publisher_platform'], limit: 500 });
    S.platWin = { since, until, unsub: null };
    S.platWin.unsub = S.mcp.watchTool(SERVER, 'ads_get_ad_entities', spec, (ev) => {
      if (ev.type === 'data') { const p = payloadOf(ev.result); if (p && typeof p === 'object') { S.raw.platWin = p; renderPlat(); } }
      else console.warn('watch platWin', ev.error);
    }, { refetchInterval: REFRESH_MS, cache: CACHE_OPTS });
  }`,
`  // Aqui a quebra por posicionamento é a do período inteiro, que já vem no data.json:
  // não há como pedir uma janela menor à Meta de dentro da página publicada.
  function ensurePlatWindow() {}`, 'janela de posicionamento');

/* os botões do cartão de planilhas não existem mais nesta versão */
replaceOnce(`  // setup card actions (the card is re-rendered, so the handlers live on the section)
  document.getElementById('secScore').addEventListener('click', async (ev) => {`,
`  // o cartão de escolher planilhas não existe na página publicada
  document.getElementById('secScore').addEventListener('click', async (ev) => {
    return;
    /* eslint-disable no-unreachable */`, 'abre o handler do cartão');

replaceOnce('<th title="linhas da planilha no período">Leads (planilha)</th>',
  '<th title="respostas do formulário no período">Leads (formulário)</th>', 'coluna de leads da tabela');

/* 6d. o cartão "cole o link das planilhas" não faz sentido nesta página: quem a abre não
      configura fonte de dados nenhuma. No estado de erro fica só a explicação. */
replaceOnce("' + sheetStatusHtml() + setupCard();", "' + sheetStatusHtml();", 'cartão de planilhas no estado de erro');

replaceOnce('Os dois números podem não bater exatamente: a Meta conta o lead no dia do clique e a planilha no momento do envio, e a planilha pode conter leads de outros períodos ou campanhas.',
  'Os dois números podem não bater exatamente: a Meta conta o lead no dia do clique e o formulário no momento do envio.', 'rodapé sobre a diferença de contagem');

/* 7. boot */
const bootStart = html.indexOf('  (async function boot() {');
const bootEnd = html.indexOf('  })();', bootStart);
if (bootStart === -1 || bootEnd === -1) throw new Error('não encontrei o boot');
html = html.slice(0, bootStart) + `  function failed(e) {
    S.offline = true; setLive('err', 'sem dados');
    const local = location.protocol === 'file:';
    banner('critical', local ? 'Abra a página por um servidor, não como arquivo' : 'Não consegui carregar os dados',
      local ? 'O navegador bloqueia a leitura do data.json quando a página é aberta direto do disco (file://). Publique no GitHub Pages ou rode "npx serve public" na pasta do projeto.'
            : 'O arquivo data.json não pôde ser lido (' + (e && e.message ? e.message : 'erro desconhecido') + '). Se a página acabou de ser publicada, aguarde a primeira atualização automática terminar na aba Actions do repositório; depois recarregue.');
    renderAll();
  }
  (async function boot() {
    try { await load(); } catch (e) { console.warn('boot', e); failed(e); }
    // recarrega sozinho de tempos em tempos: a atualização automática roda de hora em hora
    setInterval(() => { load().catch((e) => console.warn('auto', e)); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load().catch(() => {}); });
  })();` + html.slice(bootEnd + '  })();'.length);

/* conferências finais */
for (const proibido of ['window.claude', 'mcp.watchTool', 'S.mcp', 'claude.ai', 'ACCESS_STEPS']) {
  const at = html.indexOf(proibido);
  if (at !== -1) throw new Error('sobrou referência ao conector: ' + proibido + '\n  ...' + html.slice(Math.max(0, at - 160), at + 160).replace(/\s+/g, ' ') + '...');
}
if (!html.startsWith('<!DOCTYPE html>')) throw new Error('documento sem doctype');

await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, html);
console.log('gerado ' + dest + ' (' + Math.round(html.length / 1024) + ' KB)');
