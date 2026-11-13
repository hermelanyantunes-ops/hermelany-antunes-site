# Site profissional — Hermelany Antunes, psicóloga (CRP 02/26332)

Site institucional com foco em avaliação neuropsicológica e agenda online integrada.

- **Site público:** páginas estáticas, rápidas e otimizadas para busca (SEO).
- **Agenda online:** disponibilidade real, prevenção de conflitos, confirmação, cancelamento pelo paciente.
- **Painel administrativo:** `/admin/` — restrito às contas autorizadas.
- **Integração Google:** eventos no Google Agenda, horários ocupados bloqueados no site e confirmação por e-mail (Gmail).

## Tecnologias

| Parte | Tecnologia | Por quê |
|---|---|---|
| Páginas | HTML, CSS e JavaScript puros, gerados por `scripts/build.mjs` (sem dependências) | Carregamento rápido, nada para atualizar ou quebrar |
| Hospedagem | Firebase Hosting (HTTPS automático) | Conforme solicitado |
| Banco de dados | Supabase (PostgreSQL), esquema `agenda` no projeto `psiando_global` | Agenda, disponibilidade e configurações |
| Integração | Supabase Edge Function `agenda-google` | Google Agenda e Gmail via OAuth |
| Código | GitHub | Versionamento |
| Fontes | Playfair Display e Hanken Grotesk (licença OFL), hospedadas no próprio site | Sem chamadas a terceiros |

## Estrutura

```
src/
  config/site.json        ← contatos, WhatsApp, Instagram, endereço, foto
  pages/                  ← uma página por arquivo (textos do site)
  partials/               ← cabeçalho, rodapé, etapas do processo, layout
  assets/css|js|img|fonts
scripts/
  build.mjs               ← gera a pasta dist/
  gerar-contornos.py      ← desenho das linhas de contorno (opcional)
supabase/
  migrations/             ← estrutura do banco da agenda
  functions/agenda-google ← integração Google Agenda + Gmail
firebase.json             ← hospedagem, cabeçalhos de segurança, cache
.github/workflows/        ← publicação automática no Firebase
```

## Como atualizar

### Contatos (WhatsApp, Instagram, endereço, horários)
Edite `src/config/site.json`. Campos vazios ficam ocultos no site.

- `whatsapp`: somente números com 55 + DDD, ex.: `5581999999999`. Enquanto estiver vazio, os botões de WhatsApp abrem um e-mail.
- `instagram`: somente o usuário, sem @.
- `enderecoPresencial`, `linkMapa`, `horarioAtendimento`.
- As mensagens iniciais do WhatsApp (paciente, profissional, atendimento) ficam em `mensagensWhatsApp`.

### Cores e foto do topo
Em `src/config/site.json`: `"tema"` aceita `"vinho"` ou `"verde"`. `"fotoHero"` é a foto grande do topo da página inicial (horizontal, cerca de 2000×1250 px, salva em `src/assets/img/`); vazio usa a imagem abstrata.

### Foto
Coloque a foto em `src/assets/img/` (ex.: `hermelany.jpg`, proporção 4:5, cerca de 1200×1500 px) e preencha `"foto": "hermelany.jpg"`. Sem foto, o site exibe um bloco gráfico com seu nome.

### Textos
Cada página está em `src/pages/`. O bloco no topo (`<!--{ ... }-->`) define título e descrição para o Google. Altere apenas o texto entre as marcações HTML.

### Agenda (sem mexer em código)
Tudo é configurado no painel `/admin/`: horários de trabalho, intervalos, férias, bloqueios, horários avulsos, tipos de atendimento e duração, antecedência mínima, confirmação automática, pessoas autorizadas.

Para entrar no painel, use o e-mail hermelanyantunes@gmail.com e a senha da sua conta já existente no Supabase (a mesma do Psiando). Se não lembrar a senha, use "Esqueci minha senha" (veja a pendência sobre URLs de redirecionamento abaixo).

## Publicar

Depois de qualquer alteração em `src/`:

```bash
npm run build      # gera dist/
npm run deploy     # publica no Firebase (precisa de login uma vez: npx firebase-tools login)
```

Com o GitHub configurado, basta salvar a alteração na branch `main`: a Action publica sozinha.

### Primeira publicação no Firebase (uma única vez)
1. Em <https://console.firebase.google.com>, entre com hermelanyantunes@gmail.com e crie o projeto **hermelany-antunes** (se o ID estiver ocupado, use outro e troque em `.firebaserc`, `.github/workflows/deploy.yml` e `siteUrl` em `src/config/site.json`). Não é preciso ativar o Google Analytics.
2. No Terminal do Mac, dentro da pasta do projeto:
   ```bash
   npx firebase-tools login
   npx firebase-tools deploy --only hosting
   ```
3. O site fica em `https://hermelany-antunes.web.app`.
4. Para publicar automaticamente pelo GitHub: `npx firebase-tools init hosting:github`, informe o repositório e, quando perguntado, **não** sobrescreva `firebase.json`. Renomeie o segredo criado no GitHub para `FIREBASE_SERVICE_ACCOUNT` (ou ajuste o nome no workflow) e apague workflows duplicados que o comando criar.

### Domínio próprio
1. Registre o domínio (ex.: no Registro.br: `hermelanyantunes.com.br` ou `hermelanyantunes.psc.br`).
2. Firebase Console → Hosting → **Adicionar domínio personalizado** → siga as instruções (registros TXT e A no painel do domínio). O certificado HTTPS é emitido automaticamente.
3. Atualize `siteUrl` em `src/config/site.json` e o "Endereço do site" no painel (aba Google Agenda e e-mail). Publique de novo.
4. Se usar o Google Agenda, o endereço de retorno do OAuth não muda (fica no Supabase).

## Google Agenda e e-mail de confirmação

Siga o passo a passo na aba **Google Agenda e e-mail** do painel. Resumo:
1. Google Cloud Console → criar projeto → ativar Google Calendar API e Gmail API.
2. Tela de consentimento OAuth: tipo Externo, publicar o app.
3. Criar ID do cliente OAuth (Aplicativo da Web) com o URI de redirecionamento:
   `https://hpjnthwubydqrbdncapf.supabase.co/functions/v1/agenda-google/callback`
4. Colar ID e chave secreta no painel → **Conectar Google Agenda**.

Depois de conectado:
- cada agendamento ativo vira um evento no Google Agenda (sem duplicar: o evento guarda o identificador do agendamento);
- alterações e cancelamentos atualizam ou removem o evento;
- a cada 15 minutos, os compromissos ocupados da sua agenda são lidos e esses horários somem do site;
- o paciente recebe confirmação e, se cancelar, aviso de cancelamento, enviados pela sua conta Gmail.

## Segurança e LGPD
- As tabelas da agenda ficam no esquema `agenda`, que **não é exposto** pela API. Todo acesso passa por funções que validam os dados e verificam se quem chama é administradora.
- RLS ativado em todas as tabelas; a restrição `bookings_no_overlap` impede, no próprio banco, dois atendimentos sobrepostos.
- O site coleta somente nome, e-mail, telefone, tipo, modalidade, horário e observação administrativa opcional. Não há campos clínicos.
- Segredos (chave do Google, token de acesso, chave interna) ficam no Supabase Vault, criptografados. Nada sensível no código.
- A chave `sb_publishable_…` em `site.json` é pública por definição (equivale à antiga "anon key") e só permite chamar as funções públicas da agenda.
- Painel → Configurações → **Anonimizar** agendamentos antigos (recomendado periodicamente).
- Cabeçalhos de segurança (CSP, HSTS, X-Frame-Options etc.) em `firebase.json`.

## Google Analytics e Search Console
- **Search Console:** adicione a propriedade, escolha "Tag HTML" e cole o valor `content` em `googleSiteVerification`. Depois envie o sitemap `https://SEU-SITE/sitemap.xml`.
- **Analytics (opcional):** preencha `googleAnalyticsId` (G-XXXX). Antes, atualize a seção de cookies da Política de Privacidade.

## Banco de dados (Supabase)
Projeto `psiando_global` (`hpjnthwubydqrbdncapf`), esquema `agenda`:
`admins`, `settings`, `service_types`, `availability_rules`, `time_blocks`, `extra_slots`, `bookings`, `external_busy`, `integration`, `oauth_states`.
Funções públicas: `site_get_public_config`, `site_get_slots`, `site_create_booking`, `site_get_booking`, `site_cancel_booking`.
Funções do painel: `site_admin_*` (todas verificam a autorização).
As migrações estão em `supabase/migrations/`, na ordem em que devem ser aplicadas.
