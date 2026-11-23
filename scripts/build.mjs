// =====================================================================
// Gerador do site estático — sem dependências externas.
// Uso: node scripts/build.mjs   (gera a pasta dist/)
//
// Cada página em src/pages/*.html começa com um bloco de metadados:
//   <!--{ "path": "/sobre/", "title": "...", "description": "..." }-->
// O conteúdo é inserido em src/partials/layout.html (ou na página
// inteira, se "layout": false). Marcações disponíveis:
//   {{chave}}            texto escapado        {{{chave}}}  HTML bruto
//   {{> parcial}}        inclui src/partials/parcial.html
//   {{#if chave}}…{{else}}…{{/if}}   {{#unless chave}}…{{/unless}}
// =====================================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'dist');

const site = JSON.parse(readFileSync(join(SRC, 'config/site.json'), 'utf8'));
for (const k of Object.keys(site)) if (k.startsWith('_')) delete site[k];
site.siteUrl = site.siteUrl.replace(/\/$/, '');
site.tema = site.tema === 'verde' ? 'verde' : 'vinho';

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const truthy = (v) => Array.isArray(v) ? v.length > 0 : Boolean(v);
const partial = (name) => readFileSync(join(SRC, 'partials', `${name}.html`), 'utf8');

function render(tpl, ctx, depth = 0) {
  if (depth > 10) throw new Error('Parciais aninhadas demais');
  tpl = tpl.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, n) => render(partial(n), ctx, depth + 1));
  const cond = /\{\{#(if|unless) ([\w.]+)\}\}((?:(?!\{\{#(?:if|unless) )[\s\S])*?)\{\{\/\1\}\}/;
  while (cond.test(tpl)) {
    tpl = tpl.replace(cond, (_, kind, key, body) => {
      const [a, b = ''] = body.split('{{else}}');
      const v = truthy(get(ctx, key));
      return (kind === 'if' ? v : !v) ? a : b;
    });
  }
  tpl = tpl.replace(/\{\{\{([\w.]+)\}\}\}/g, (_, k) => get(ctx, k) ?? '');
  tpl = tpl.replace(/\{\{([\w.]+)\}\}/g, (_, k) => esc(get(ctx, k) ?? ''));
  return tpl;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ---------------------------------------------------------------------
// Links de contato
// ---------------------------------------------------------------------
const digits = (site.whatsapp || '').replace(/\D/g, '');
const temWhatsapp = digits.length >= 12;
const digitsAss = (site.whatsappAssistente || '').replace(/\D/g, '');
const msg = site.mensagensWhatsApp || {};
const wa = (texto, assunto) => temWhatsapp
  ? `https://wa.me/${digits}?text=${encodeURIComponent(texto)}`
  : `mailto:${site.email}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(texto)}`;

const links = {
  temWhatsapp,
  heroImg: site.fotoHero || 'hero-abstrato.jpg',
  corTema: site.tema === 'verde' ? '#1E3B32' : '#2A1F19',
  waAttrs: temWhatsapp ? 'target="_blank" rel="noopener"' : '',
  waPaciente: wa(msg.paciente, 'Avaliação neuropsicológica'),
  waProfissional: wa(msg.profissional, 'Encaminhamento para avaliação neuropsicológica'),
  waAtendimento: wa(msg.atendimento, 'Atendimento psicológico'),
  waGeral: wa(msg.geral, 'Contato pelo site'),
  instagram: site.instagram ? `https://www.instagram.com/${site.instagram.replace(/^@/, '')}/` : '',
  whatsappFormatado: temWhatsapp ? formatPhone(digits) : '',
  temAssistente: digitsAss.length >= 12,
  waAssistente: digitsAss.length >= 12 ? `https://wa.me/${digitsAss}?text=${encodeURIComponent('Olá! Vim pelo site e gostaria de informações sobre agendamento.')}` : '',
  assistenteFormatado: digitsAss.length >= 12 ? formatPhone(digitsAss) : '',
  canalRotulo: temWhatsapp ? 'Conversar pelo WhatsApp' : 'Enviar mensagem',
};
function formatPhone(d) {
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}

// ---------------------------------------------------------------------
// Versão para cache dos arquivos estáticos
// ---------------------------------------------------------------------
const hash = createHash('sha1');
for (const f of walk(join(SRC, 'assets')).sort()) hash.update(readFileSync(f));
hash.update(JSON.stringify(site));
const build = { v: hash.digest('hex').slice(0, 10), ano: new Date().getFullYear() };

// ---------------------------------------------------------------------
// Dados estruturados (schema.org)
// ---------------------------------------------------------------------
const pessoa = {
  '@type': 'Person',
  '@id': `${site.siteUrl}/#pessoa`,
  name: site.nomeCompleto,
  alternateName: site.nome,
  jobTitle: site.profissao,
  email: `mailto:${site.email}`,
  url: `${site.siteUrl}/sobre/`,
  identifier: { '@type': 'PropertyValue', propertyID: 'CRP', value: site.crp.replace(/^CRP\s*/, '') },
  alumniOf: [
    { '@type': 'CollegeOrUniversity', name: 'Universidade de Pernambuco (UPE)' },
    { '@type': 'CollegeOrUniversity', name: 'Pontifícia Universidade Católica do Rio Grande do Sul (PUC-RS)' },
    { '@type': 'EducationalOrganization', name: 'INAP' },
  ],
  knowsAbout: ['Avaliação neuropsicológica', 'Neuropsicologia', 'Terapia cognitivo-comportamental', 'Psicologia clínica'],
  ...(site.instagram ? { sameAs: [links.instagram] } : {}),
};
const servico = {
  '@type': 'ProfessionalService',
  '@id': `${site.siteUrl}/#servico`,
  name: `${site.nome} — ${site.profissao}`,
  description: 'Avaliação neuropsicológica e atendimento psicológico presencial e online.',
  url: `${site.siteUrl}/`,
  email: site.email,
  ...(temWhatsapp ? { telephone: `+${digits}` } : {}),
  areaServed: [{ '@type': 'City', name: site.cidade }, { '@type': 'Country', name: 'Brasil' }],
  address: site.enderecoPresencial
    ? { '@type': 'PostalAddress', streetAddress: site.enderecoPresencial, addressLocality: site.cidade, addressRegion: site.uf, addressCountry: 'BR' }
    : { '@type': 'PostalAddress', addressLocality: site.cidade, addressRegion: site.uf, addressCountry: 'BR' },
  founder: { '@id': `${site.siteUrl}/#pessoa` },
  image: `${site.siteUrl}/assets/img/compartilhar-2.jpg`,
  ...(site.horarioAtendimento ? { hoursAvailable: site.horarioAtendimento } : {}),
};

// ---------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const layout = partial('layout');
const pages = [];
for (const file of readdirSync(join(SRC, 'pages')).filter((f) => f.endsWith('.html')).sort()) {
  const raw = readFileSync(join(SRC, 'pages', file), 'utf8');
  const m = raw.match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!m) throw new Error(`Página sem metadados: ${file}`);
  const page = JSON.parse(m[1]);
  const body = raw.slice(m[0].length);
  page.url = `${site.siteUrl}${page.path}`;

  const graph = [pessoa, servico, {
    '@type': 'WebPage', '@id': `${page.url}#pagina`, url: page.url, name: page.title,
    description: page.description, inLanguage: 'pt-BR', isPartOf: { '@id': `${site.siteUrl}/#site` },
    about: { '@id': `${site.siteUrl}/#servico` },
  }, { '@type': 'WebSite', '@id': `${site.siteUrl}/#site`, url: `${site.siteUrl}/`, name: site.nome, inLanguage: 'pt-BR' }];
  if (page.breadcrumb) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Início', item: `${site.siteUrl}/` },
        { '@type': 'ListItem', position: 2, name: page.breadcrumb, item: page.url }],
    });
  }
  if (page.faq) graph.push({ '@type': 'FAQPage', mainEntity: page.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  page.jsonld = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');

  const cur = {};
  if (page.nav) cur[page.nav] = 'aria-current="page"';
  const ctx = { site, page, links, build, cur };
  const content = render(body, ctx);
  const html = page.layout === false ? content : render(layout, { ...ctx, content });

  const outPath = page.path === '/404' ? join(OUT, '404.html') : join(OUT, page.path, 'index.html');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  pages.push(page);
}

// ---------------------------------------------------------------------
// Arquivos estáticos
// ---------------------------------------------------------------------
for (const f of walk(join(SRC, 'assets'))) {
  const dest = join(OUT, 'assets', relative(join(SRC, 'assets'), f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
}

// Sitemap e robots
const hoje = new Date().toISOString().slice(0, 10);
const indexaveis = pages.filter((p) => !p.noindex && p.path !== '/404');
writeFileSync(join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  indexaveis.map((p) => `  <url><loc>${site.siteUrl}${p.path}</loc><lastmod>${hoje}</lastmod><priority>${p.priority ?? '0.7'}</priority></url>`).join('\n') +
  `\n</urlset>\n`);
writeFileSync(join(OUT, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${site.siteUrl}/sitemap.xml\n`);

console.log(`✓ ${pages.length} páginas geradas em dist/ (versão ${build.v})${temWhatsapp ? '' : ' — WhatsApp ainda não configurado: botões usam e-mail'}`);
