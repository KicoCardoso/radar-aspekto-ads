#!/usr/bin/env node
/**
 * Testes do coletor, com respostas simuladas da API da Meta (não usa rede nem token).
 *
 *   node scripts/testes.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, localYMD, isoWithOffset, actionsMap, metricsOf, budgetOf, deliveryOf, joinLevel, dailyRows, makeClient, collect } from './fetch-meta.mjs';

const TZ = 'America/Sao_Paulo';

test('periodRange: mês atual até hoje, comparado com os mesmos dias do mês anterior', () => {
  const r = periodRange(new Date('2026-09-17T12:00:00Z'), TZ);
  assert.equal(r.since, '2026-09-01');
  assert.equal(r.until, '2026-09-17');
  assert.equal(r.today, '2026-09-17');
  assert.equal(r.cSince, '2026-08-01');
  assert.equal(r.cUntil, '2026-08-17');
});

test('periodRange: vira o ano em janeiro', () => {
  const r = periodRange(new Date('2027-01-05T12:00:00Z'), TZ);
  assert.equal(r.since, '2027-01-01');
  assert.equal(r.cSince, '2026-12-01');
  assert.equal(r.cUntil, '2026-12-05');
});

test('periodRange: dia 31 comparado com um mês de 30 dias', () => {
  const r = periodRange(new Date('2026-10-31T12:00:00Z'), TZ);
  assert.equal(r.until, '2026-10-31');
  assert.equal(r.cUntil, '2026-09-30', 'setembro tem 30 dias');
});

test('periodRange: usa o fuso da conta, não o UTC', () => {
  // 02:00 UTC do dia 1º ainda é dia 30 do mês anterior em São Paulo (UTC-3)
  const r = periodRange(new Date('2026-10-01T02:00:00Z'), TZ);
  assert.equal(r.today, '2026-09-30');
  assert.equal(r.since, '2026-09-01');
  assert.deepEqual(localYMD(new Date('2026-10-01T02:00:00Z'), TZ), { y: 2026, m: 9, d: 30 });
});

test('isoWithOffset: carimbo com o deslocamento do fuso', () => {
  assert.equal(isoWithOffset(new Date('2026-09-17T12:34:56Z'), TZ), '2026-09-17T09:34:56-03:00');
  assert.equal(isoWithOffset(new Date('2026-09-17T12:34:56Z'), 'UTC'), '2026-09-17T12:34:56+00:00');
});

test('actionsMap: lista de ações vira mapa', () => {
  assert.deepEqual(actionsMap([{ action_type: 'lead', value: '12' }, { action_type: 'link_click', value: '340' }]), { lead: 12, link_click: 340 });
  assert.deepEqual(actionsMap(undefined), {});
});

test('budgetOf: centavos viram reais; moedas sem centavos passam direto', () => {
  assert.equal(budgetOf('33750', 'BRL'), 337.5);
  assert.equal(budgetOf('20000', 'BRL'), 200);
  assert.equal(budgetOf('1500', 'JPY'), 1500);
  assert.equal(budgetOf(null, 'BRL'), 0);
});

test('deliveryOf: status efetivo vira o formato que a página entende', () => {
  assert.equal(deliveryOf('ACTIVE').status, 'active');
  assert.equal(deliveryOf('PAUSED').status, 'inactive');
  assert.equal(deliveryOf('WITH_ISSUES').status, 'error');
  assert.equal(deliveryOf('PENDING_REVIEW').status, 'pending');
});

test('metricsOf: campanha de formulário', () => {
  const m = metricsOf({ spend: '16570.28', impressions: '838721', reach: '614206', inline_link_clicks: '9000', ctr: '1.07', cpm: '19.76', frequency: '1.37',
    actions: [{ action_type: 'lead', value: '701' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '120' }] }, 'Formulário');
  assert.equal(m.amount_spent, 16570.28);
  assert.equal(m.lead, 701);
  assert.equal(m.conversations, 120);
  assert.equal(m.cost_per_lead, 23.64);
  assert.equal(m.results.indicator, 'actions:lead');
  assert.equal(m.results.values[0].value, 701);
});

test('metricsOf: campanha de WhatsApp usa conversas como resultado', () => {
  const m = metricsOf({ spend: '1000', impressions: '50000', reach: '30000', inline_link_clicks: '800',
    actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '40' }] }, 'WhatsApp');
  assert.equal(m.conversations, 40);
  assert.equal(m['cost_per_action_type:onsite_conversion.messaging_conversation_started_7d'], 25);
  assert.equal(m.results.indicator, 'actions:onsite_conversion.messaging_conversation_started_7d');
});

test('metricsOf: linha sem dados não quebra e não inventa número', () => {
  const m = metricsOf(null, 'Formulário');
  assert.equal(m.amount_spent, 0);
  assert.equal(m.lead, 0);
  assert.equal(m.cost_per_lead, null);
  assert.equal(m.ctr, 0);
});

test('metricsOf: CTR e CPM são calculados quando a Meta não os envia', () => {
  const m = metricsOf({ spend: '100', impressions: '10000', reach: '8000', inline_link_clicks: '200', actions: [] }, 'Outros');
  assert.equal(m.ctr, 2);
  assert.equal(m.cpm, 10);
  assert.equal(m.frequency, 1.25);
});

test('joinLevel: entidade sem gasto continua na lista, com métricas zeradas', () => {
  const out = joinLevel({ level: 'campaign', currency: 'BRL',
    entities: [{ id: '1', name: '[BH][Leads][Formulario][L1] Gatilho preço', effective_status: 'ACTIVE', daily_budget: '33750', objective: 'OUTCOME_LEADS' },
               { id: '2', name: '[SP][Engajamento][Whatsapp][E1] Preço', effective_status: 'PAUSED', daily_budget: '50000' }],
    insights: [{ campaign_id: '1', spend: '900', impressions: '1000', actions: [{ action_type: 'lead', value: '10' }] }] });
  const byId = Object.fromEntries(out.map((c) => [c.id, c]));
  assert.equal(out.length, 2);
  assert.equal(byId['1'].daily_budget, 337.5);
  assert.equal(byId['1'].lead, 10);
  assert.equal(byId['2'].amount_spent, 0, 'campanha pausada sem gasto no período');
  assert.equal(byId['2'].daily_budget, 500);
  assert.equal(byId['2'].delivery.status, 'inactive');
});

test('joinLevel: gasto de item arquivado ainda entra no total', () => {
  const out = joinLevel({ level: 'campaign', currency: 'BRL', entities: [],
    insights: [{ campaign_id: '9', campaign_name: '[BH] Campanha antiga', spend: '500', actions: [] }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].amount_spent, 500);
  assert.equal(out[0].name, '[BH] Campanha antiga');
});

test('joinLevel: conjunto herda o nome da campanha e o estágio de aprendizado', () => {
  const campaignsById = { '1': { id: '1', name: '[BH][Leads][Formulario][L2] Objeções', objective: 'OUTCOME_LEADS' } };
  const out = joinLevel({ level: 'adset', currency: 'BRL', campaignsById,
    entities: [{ id: '10', name: 'Objeções', campaign_id: '1', effective_status: 'ACTIVE', daily_budget: '24200', optimization_goal: 'LEAD_GENERATION', learning_stage_info: { status: 'LEARNING' } }],
    insights: [{ adset_id: '10', campaign_id: '1', spend: '5311.96', actions: [{ action_type: 'lead', value: '250' }] }] });
  assert.equal(out[0].campaign_name, '[BH][Leads][Formulario][L2] Objeções');
  assert.equal(out[0].daily_budget, 242);
  assert.equal(out[0].delivery_sub_status, 'LEARNING');
});

test('dailyRows: mantém a data de cada linha', () => {
  const rows = dailyRows([{ campaign_id: '1', date_start: '2026-09-01', date_stop: '2026-09-01', spend: '100', actions: [{ action_type: 'lead', value: '4' }] }],
    { '1': { id: '1', name: '[BH][Leads][Formulario][L1] X' } });
  assert.equal(rows[0].date_start, '2026-09-01');
  assert.equal(rows[0].lead, 4);
  assert.equal(rows[0].amount_spent, 100);
});

/* ---------- cliente: paginação, repetição e erros ---------- */
function fakeFetch(routes) {
  const chamadas = [];
  const fn = async (url) => {
    const u = new URL(url);
    chamadas.push(u);
    const token = u.searchParams.get('access_token');
    assert.ok(token, 'toda chamada leva o token');
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    const handler = routes[key];
    if (!handler) throw new Error('rota não simulada: ' + key);
    const r = typeof handler === 'function' ? handler(u) : handler;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
  fn.chamadas = chamadas;
  return fn;
}

test('cliente: segue a paginação até o fim', async () => {
  let pagina = 0;
  const fetchImpl = fakeFetch({
    'act_1/campaigns': () => {
      pagina++;
      return pagina === 1
        ? { body: { data: [{ id: 'a' }], paging: { cursors: { after: 'CUR' }, next: 'https://…' } } }
        : { body: { data: [{ id: 'b' }], paging: { cursors: { after: 'CUR2' } } } };
    },
  });
  const client = makeClient({ token: 't', fetchImpl });
  const out = await client.all('act_1/campaigns', { fields: 'id' });
  assert.deepEqual(out.map((x) => x.id), ['a', 'b']);
  assert.equal(fetchImpl.chamadas[1].searchParams.get('after'), 'CUR');
});

test('cliente: repete erro temporário e depois entrega', async () => {
  let n = 0;
  const fetchImpl = fakeFetch({
    'act_1/insights': () => (++n < 3 ? { ok: false, status: 500, body: { error: { code: 2, message: 'temporário' } } } : { body: { data: [{ spend: '1' }] } }),
  });
  const client = makeClient({ token: 't', fetchImpl, sleep: async () => {} });
  const out = await client.all('act_1/insights', {});
  assert.equal(out.length, 1);
  assert.equal(n, 3);
});

test('cliente: token expirado falha na hora, com explicação', async () => {
  const fetchImpl = fakeFetch({ 'act_1/insights': { ok: false, status: 400, body: { error: { code: 190, message: 'Session has expired' } } } });
  const client = makeClient({ token: 't', fetchImpl, sleep: async () => {} });
  await assert.rejects(() => client.all('act_1/insights', {}), (e) => {
    assert.match(e.message, /código 190/);
    assert.match(e.message, /gere um token novo/i);
    return true;
  });
  assert.equal(fetchImpl.chamadas.length, 1, 'não insiste em erro permanente');
});

test('cliente: sem permissão na conta explica o que fazer', async () => {
  const fetchImpl = fakeFetch({ 'act_1/insights': { ok: false, status: 400, body: { error: { code: 200, message: 'Requires ads_read' } } } });
  const client = makeClient({ token: 't', fetchImpl, sleep: async () => {} });
  await assert.rejects(() => client.all('act_1/insights', {}), /ads_read/);
});

/* ---------- coleta completa ---------- */
test('collect: monta o data.json inteiro a partir da API', async () => {
  const insights = (u) => {
    const level = u.searchParams.get('level');
    const tr = JSON.parse(u.searchParams.get('time_range'));
    const inc = u.searchParams.get('time_increment');
    if (tr.since === '2026-08-01') return { body: { data: [{ campaign_id: '1', spend: '8000', impressions: '400000', actions: [{ action_type: 'lead', value: '300' }] }] } };
    if (inc) return { body: { data: [
      { campaign_id: '1', date_start: '2026-09-01', date_stop: '2026-09-01', spend: '1000', impressions: '50000', actions: [{ action_type: 'lead', value: '40' }] },
      { campaign_id: '2', date_start: '2026-09-01', date_stop: '2026-09-01', spend: '500', impressions: '20000', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' }] },
    ] } };
    if (level === 'campaign') return { body: { data: [
      { campaign_id: '1', spend: '9000', impressions: '450000', reach: '300000', inline_link_clicks: '5000', actions: [{ action_type: 'lead', value: '360' }] },
      { campaign_id: '2', spend: '4500', impressions: '180000', reach: '120000', inline_link_clicks: '2000', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '180' }] },
    ] } };
    if (level === 'adset') return { body: { data: [{ adset_id: '10', campaign_id: '1', spend: '9000', impressions: '450000', actions: [{ action_type: 'lead', value: '360' }] }] } };
    return { body: { data: [{ ad_id: '100', adset_id: '10', campaign_id: '1', spend: '9000', impressions: '450000', actions: [{ action_type: 'lead', value: '360' }], video_thruplay_watched_actions: [{ action_type: 'video_view', value: '1200' }] }] } };
  };
  const fetchImpl = fakeFetch({
    'act_1545616483609687': { body: { name: 'Henrique', currency: 'BRL', timezone_name: TZ, account_id: '1545616483609687' } },
    'act_1545616483609687/campaigns': { body: { data: [
      { id: '1', name: '[BH][Leads][Formulario][L1] Gatilho preço', effective_status: 'ACTIVE', daily_budget: '33750', objective: 'OUTCOME_LEADS' },
      { id: '2', name: '[SP][Engajamento][Whatsapp][E1] Preço', effective_status: 'ACTIVE', daily_budget: '67500', objective: 'OUTCOME_ENGAGEMENT' },
    ] } },
    'act_1545616483609687/adsets': { body: { data: [{ id: '10', name: 'Gatilho preço', campaign_id: '1', effective_status: 'ACTIVE', daily_budget: '33750', optimization_goal: 'LEAD_GENERATION' }] } },
    'act_1545616483609687/ads': { body: { data: [{ id: '100', name: 'Ad vencedor', adset_id: '10', campaign_id: '1', effective_status: 'ACTIVE' }] } },
    'act_1545616483609687/insights': insights,
  });
  const client = makeClient({ token: 't', fetchImpl });
  const data = await collect({ client, account: 'act_1545616483609687', now: new Date('2026-09-17T15:00:00Z') });

  assert.equal(data.account.name, 'Henrique');
  assert.equal(data.account.currency, 'BRL');
  assert.equal(data.range.since, '2026-09-01');
  assert.equal(data.range.until, '2026-09-17');
  assert.equal(data.campaigns.length, 2);
  assert.equal(data.campaigns.find((c) => c.id === '1').lead, 360);
  assert.equal(data.campaigns.find((c) => c.id === '1').daily_budget, 337.5);
  assert.equal(data.campaigns.find((c) => c.id === '2').conversations, 180);
  assert.equal(data.adsets[0].campaign_name, '[BH][Leads][Formulario][L1] Gatilho preço');
  assert.equal(data.ads[0].video_thruplay_watched_actions, 1200);
  assert.equal(data.daily.length, 2);
  assert.equal(data.prev.length, 1);
  assert.match(data.generatedAt, /^2026-09-17T12:00:00-03:00$/);
  assert.ok(JSON.stringify(data).length > 500);
});
