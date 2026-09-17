#!/usr/bin/env node
/**
 * Confere public/data.json antes de publicar: se a leitura vier quebrada, o
 * workflow falha aqui em vez de publicar uma página vazia por cima de uma boa.
 *
 *   node scripts/verificar-dados.mjs [caminho]
 */
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || process.env.RADAR_OUT || 'public/data.json';
const problemas = [];
const avisos = [];

let data;
try {
  data = JSON.parse(await readFile(file, 'utf8'));
} catch (e) {
  console.error(`ERRO: não consegui ler ${file}: ${e.message}`);
  process.exit(1);
}

const arr = (k) => (Array.isArray(data[k]) ? data[k] : null);
for (const k of ['campaigns', 'adsets', 'ads', 'daily', 'prev']) {
  if (!arr(k)) problemas.push(`campo "${k}" ausente ou não é uma lista`);
}
if (!data.range || !data.range.since || !data.range.until) problemas.push('campo "range" incompleto');
if (!data.generatedAt || !isFinite(new Date(data.generatedAt).getTime())) problemas.push('campo "generatedAt" inválido');
if (!data.account || !data.account.id) problemas.push('campo "account" incompleto');

if (!problemas.length) {
  const campanhas = arr('campaigns');
  if (!campanhas.length) problemas.push('nenhuma campanha retornada — provavelmente o token não enxerga a conta');

  const gasto = campanhas.reduce((t, c) => t + (Number(c.amount_spent) || 0), 0);
  const dias = new Set(arr('daily').map((d) => d.date_start));
  const semTag = campanhas.filter((c) => !/\[\s*(BH|SP)\s*\]/i.test(c.name || '') && (Number(c.amount_spent) || 0) > 0);

  if (gasto <= 0) avisos.push('investimento zerado no período (normal só no primeiro dia do mês, de madrugada)');
  if (!dias.size) avisos.push('série diária vazia');
  if (semTag.length) avisos.push(`${semTag.length} campanha(s) com gasto e sem tag [BH]/[SP] — vão aparecer como "Outros"`);

  const idade = (Date.now() - new Date(data.generatedAt).getTime()) / 6e4;
  if (idade > 30) avisos.push(`o arquivo foi gerado há ${Math.round(idade)} minutos`);

  console.log(`conta ${data.account.name || data.account.id} · período ${data.range.since} a ${data.range.until}`);
  console.log(`campanhas ${campanhas.length} · conjuntos ${arr('adsets').length} · anúncios ${arr('ads').length} · dias ${dias.size}`);
  console.log(`investimento no período: ${(data.account.currency || 'BRL')} ${gasto.toFixed(2)}`);
}

for (const a of avisos) console.log('aviso: ' + a);
if (problemas.length) {
  for (const p of problemas) console.error('ERRO: ' + p);
  process.exit(1);
}
console.log('data.json ok');
