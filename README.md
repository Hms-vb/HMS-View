# HMS-TV — IPTV com proxy para Cloudflare Pages

Projeto pronto para publicar o player HMS-TV e resolver os bloqueios de CORS/HTTPS
que impedem listas M3U, filmes e canais ao vivo de abrir no navegador.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Player completo (Xtream Codes, listas M3U/M3U8, filmes, séries, canais, favoritos e histórico). |
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

- Encaminha `Range`/`If-Range` (necessário para MP4 e alguns streams).
- Preserva status `206 Partial Content`.
- Reescreve playlists HLS (`.m3u8`): sub-playlists, segmentos, chaves AES e mapas
  de inicialização também passam por `/api/proxy`, evitando CORS no meio do vídeo.
- Bloqueia destinos locais/privados (localhost, 10.x, 172.16–31.x, 192.168.x etc.)
  para reduzir risco de SSRF.
- Segue redirecionamentos validando cada destino.

## Limites e observações

- O proxy não quebra DRM nem contorna bloqueios geográficos do provedor.
- Provedores que bloqueiam IPs do Cloudflare podem continuar indisponíveis; nesse
  caso use a lista `.m3u` local e/ou um player externo (VLC/MX Player).
- Em uma página HTTPS, streams HTTP puros podem ser bloqueados pelo navegador
  (mixed content). O proxy resolve isso quando a origem permite a conexão.
- O HTML continua funcionando como arquivo único para Xtream/M3U, desde que a
  origem libere CORS ou você use um proxy publicado.
