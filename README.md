# HMS-TV — IPTV com proxy para Cloudflare Pages

Projeto pronto para publicar o player HMS-TV e resolver os bloqueios de CORS/HTTPS
que impedem listas M3U, filmes e canais ao vivo de abrir no navegador.

## Recursos

- Login por **Xtream Codes** (servidor, usuário e senha) ou por **lista M3U/M3U8**.
- **Modo rápido automático:** se a URL da lista for `get.php` com `username` e
  `password`, o app tenta primeiro a API Xtream Codes. O catálogo costuma ser
  muito menor que a lista M3U completa. Se a API não estiver disponível, o app
  baixa a M3U normalmente, sem intervenção.
- **Continuar de onde parou:** ao reabrir um filme ou episódio, aparece a opção
  **Continuar** ou **Assistir do início**. O progresso fica salvo no
  `localStorage` do navegador.
- **Séries:** o app reabre a última temporada/episódio assistido e mostra uma
  barra de progresso nos cards e nos episódios.
- **Volume no player:** botão de mudo, botões **−** e **+**, slider e percentual.
  Atalhos: `↑` aumenta, `↓` diminui e `M` silencia.
- **Proxy CORS/HTTPS** para listas, APIs Xtream, HLS, MP4 e canais `.ts`.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Player completo (Xtream Codes, listas M3U/M3U8, filmes, séries, canais, favoritos, histórico e retomada). |
| `functions/api/proxy.js` | Proxy CORS/HTTPS publicado automaticamente em `/api/proxy` pelo Cloudflare Pages. |
| `hls.min.js` | Biblioteca HLS local (fallback quando o CDN está bloqueado). |
| `mpegts.min.js` | Biblioteca para canais ao vivo no formato `.ts` (fallback local). |
| `wrangler.toml` | Configuração do projeto para deploy via Wrangler/Cloudflare Pages. |

## Como usar localmente (arquivo no computador)

1. Abra `index.html` no navegador.
2. Na tela de login, escolha **Lista M3U / URL**.
3. Se o link da lista não abrir por CORS, baixe o arquivo `.m3u` e selecione-o em
   **“Ou selecione um arquivo .m3u do dispositivo”**. O arquivo é lido direto pelo
   navegador, sem depender de proxy.
4. Para canais/filmes que usam HTTP ou bloqueiam CORS, informe em
   **⚙️ Conexão / Proxy** a URL de um proxy publicado no Cloudflare, por exemplo:
   `https://seu-projeto.pages.dev/api/proxy?url=`

Ao abrir como `file://`, o app tenta conexão direta primeiro. Um proxy só é usado
se você configurar um. Isso evita a tela de erro causada por `/api/proxy` local,
que não existe quando o HTML é aberto como arquivo.

## Publicar no Cloudflare Pages

### Opção A — Integração com Git (recomendado)

1. Envie esta pasta para um repositório GitHub/GitLab.
2. No painel do Cloudflare Pages, crie um projeto conectado ao repositório.
3. Configuração de build:
   - **Framework preset:** None
   - **Build command:** deixe vazio
   - **Build output directory:** `/` (ou `.`)
4. Publique. A pasta `functions/` é detectada automaticamente e cria a rota
   `/api/proxy`.

### Opção B — Wrangler (upload direto com Functions)

Com Node.js instalado:

```bash
npx wrangler pages deploy . --project-name hms-tv
```

O upload pelo painel (“Direct Upload” arrastando arquivos) **não publica a pasta
`functions`**. Use Git ou Wrangler para ter o proxy funcionando.

### Configuração no app

Depois de publicado, abra o site `https://seu-projeto.pages.dev`. Em
**⚙️ Conexão / Proxy**, mantenha **Automático (recomendado)**. Em HTTPS o app usa
`/api/proxy` sozinho para listas, APIs Xtream, HLS, MP4 e canais `.ts`.

## Variáveis de ambiente opcionais

Configure em **Cloudflare Pages → Settings → Variables and Secrets**:

| Variável | Exemplo | Efeito |
|---|---|---|
| `ALLOWED_HOSTS` | `meuservidor.com,*.meuprovedor.com` | Só permite que o proxy acesse esses hosts. Recomendado para não deixar um proxy aberto. |
| `ALLOWED_ORIGINS` | `https://hms-tv.pages.dev` | Restringe quais sites podem chamar o proxy pelo navegador. |

Sem essas variáveis o proxy é aberto (CORS `*`), o que facilita o teste, mas não é
recomendado para uso público.

## Como o proxy funciona

- **Listas M3U grandes são repassadas em streaming.** O proxy não carrega a lista
  inteira na memória. Isso é essencial no Cloudflare Pages Functions, cujo limite
  de memória é de aproximadamente 128 MB — uma lista de 100 MB ou mais não pode
  ser bufferizada.
- **Somente manifestos HLS (`.m3u8`) são lidos e reescritos**, para que
  sub-playlists, segmentos, chaves AES e mapas de inicialização também passem por
  `/api/proxy` e não sofram bloqueio de CORS.
- Encaminha `Range`/`If-Range` e preserva status `206 Partial Content` para MP4 e
  outros streams.
- Segue redirecionamentos validando cada destino.
- Bloqueia destinos locais/privados (localhost, 10.x, 172.16–31.x, 192.168.x etc.)
  para reduzir risco de SSRF.

### Listas M3U muito grandes

Uma lista `get.php?...type=m3u_plus` pode ter **mais de 100 MB**. O app mostra o
progresso do download (“Baixando 42% • 50 MB”) e permite até cerca de 3 minutos de
transferência, desde que os dados continuem chegando. Se o link tiver usuário e
senha, o **modo rápido Xtream** normalmente evita baixar esse arquivo inteiro.

Antes de enviar a lista pelo proxy, o app tenta o **equivalente HTTPS direto** da
URL. Se a origem liberar CORS (muitas liberam), a lista grande é baixada
diretamente pelo navegador e não passa pelas Functions. O proxy continua sendo
usado para os streams que precisam de HTTPS/CORS.

## Se a lista não carregar no Cloudflare

1. **Confirme que as Functions foram publicadas.** Abra no navegador uma URL
   pequena pelo proxy, por exemplo:
   `https://seu-projeto.pages.dev/api/proxy?url=https%3A%2F%2Fexample.com`
   - Se aparecer uma página HTML, 404 ou erro de rota, a pasta `functions` não foi
     publicada. Use Git ou `wrangler pages deploy`; o upload direto pelo painel
     não inclui Functions.
2. **Veja a mensagem de erro no app.** O texto indica se o problema foi proxy não
   publicado, host bloqueado, tempo esgotado ou falha de rede.
3. **Confira `ALLOWED_HOSTS`.** Se a variável estiver configurada, o domínio da
   lista e o host para onde os streams redirecionam precisam estar na lista. Você
   pode usar `*` durante o teste.
4. **Aguarde o download da M3U.** Em conexões de ~1,5 MB/s, uma lista de 118 MB
   leva cerca de 80 segundos. Não feche a aba durante o carregamento.
5. **Prefira o modo rápido.** Com uma URL `get.php` que tenha `username` e
   `password`, o app tenta a API Xtream primeiro. Se o provedor bloquear a API, ele
   volta automaticamente para a M3U.
6. **Provedores que bloqueiam IPs do Cloudflare** podem continuar indisponíveis.
   Nesse caso, baixe a lista `.m3u` e selecione o arquivo localmente, ou use um
   player externo (VLC/MX Player).

## Limites e observações

- O proxy não quebra DRM nem contorna bloqueios geográficos do provedor.
- O progresso de reprodução é local: fica no navegador/dispositivo em que foi
  assistido e não é sincronizado entre aparelhos.
- Em uma página HTTPS, streams HTTP puros podem ser bloqueados pelo navegador
  (mixed content). O proxy resolve isso quando a origem permite a conexão.
- O HTML continua funcionando como arquivo único para Xtream/M3U, desde que a
  origem libere CORS ou você use um proxy publicado.
