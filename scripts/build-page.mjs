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
replaceOnce('</style>\n', `  /* --- ajuste de largura fora do visualizador de artifacts --- */
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
  const KEYS = ['campaigns', 'adsets', 'ads', 'daily', 'prev', 'today'];

  function applyData(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.campaigns)) throw new Error('formato inesperado');
    if (data.range && data.range.since && data.range.until) S.range = data.range;
    for (const k of KEYS) S.raw[k] = data[k] ? { ad_entities: data[k] } : null;
    const parsed = data.generatedAt ? new Date(data.generatedAt) : new Date();
    const stamp = isFinite(parsed.getTime()) ? parsed.getTime() : Date.now();
    const at = new Date(stamp);
    S.at = stamp;
    for (const k of KEYS) if (S.raw[k]) S.stamp[k] = stamp;
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
  if (html.includes(proibido)) throw new Error('sobrou referência ao conector: ' + proibido);
}
if (!html.startsWith('<!DOCTYPE html>')) throw new Error('documento sem doctype');

await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, html);
console.log('gerado ' + dest + ' (' + Math.round(html.length / 1024) + ' KB)');
