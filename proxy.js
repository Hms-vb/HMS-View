/**
 * HMS-TV — Proxy CORS/HTTPS para Cloudflare Pages Functions.
 *
 * Rota publicada automaticamente em /api/proxy
 * Uso: /api/proxy?url=https%3A%2F%2Fservidor.com%2Flista.m3u8
 *
 * Recursos:
 *  - Libera CORS para o player (inclui preflight OPTIONS).
 *  - Encaminha Range/If-Range (essencial para MP4 e alguns streams).
 *  - Reescreve playlists HLS (.m3u8), fazendo segmentos e sub-playlists
 *    passarem pelo mesmo proxy — necessário para evitar bloqueio de CORS.
 *  - Proteção básica contra SSRF (bloqueia localhost e faixas privadas).
 *
 * Variáveis de ambiente opcionais (Cloudflare Pages > Settings > Variables):
 *  - ALLOWED_HOSTS: lista separada por vírgula. Ex.: "meuservidor.com,*.iptv.com"
 *  - ALLOWED_ORIGINS: lista separada por vírgula. Ex.: "https://meusite.pages.dev"
 */

const TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 4;
// Playlists M3U de catálogo podem ter centenas de MB. Só lemos como texto
// manifestos HLS e respostas pequenas; acima deste limite o corpo é repassado
// em streaming para não estourar a memória das Functions (~128 MB).
const MAX_TEXTO_BYTES = 4 * 1024 * 1024;

function jsonResponse(status, payload, cors) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      cors
    )
  });
}

function resolverCors(request, env) {
  const configurado = String((env && env.ALLOWED_ORIGINS) || "").trim();
  const origem = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, Origin, Cache-Control",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Date",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };

  if (!configurado) {
    headers["Access-Control-Allow-Origin"] = "*";
    return { headers: headers, permitido: true };
  }

  const permitidas = configurado.split(",").map(function (item) {
    return item.trim().replace(/\/+$/, "");
  }).filter(Boolean);
  const permitido = Boolean(origem) && permitidas.some(function (permitida) {
    return permitida === "*" || permitida === origem.replace(/\/+$/, "");
  });

  if (permitido || !origem) {
    headers["Access-Control-Allow-Origin"] = permitido ? origem : permitidas[0] || "null";
  } else {
    headers["Access-Control-Allow-Origin"] = "null";
  }
  return { headers: headers, permitido: permitido || !origem };
}

function ipv4Privado(host) {
  const partes = host.split(".");
  if (partes.length !== 4) return false;
  const numeros = partes.map(function (parte) { return Number(parte); });
  if (numeros.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return false;
  const [a, b] = numeros;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function hostBloqueado(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (host === "0.0.0.0" || host === "::1" || host === "::") return true;
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (host.startsWith("::ffff:")) {
    const resto = host.slice(7);
    const hex = resto.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const alto = parseInt(hex[1], 16);
      const baixo = parseInt(hex[2], 16);
      return ipv4Privado([alto >> 8, alto & 255, baixo >> 8, baixo & 255].join("."));
    }
    return ipv4Privado(resto);
  }
  return ipv4Privado(host);
}

function hostPermitido(hostname, env) {
  const configurado = String((env && env.ALLOWED_HOSTS) || "").trim();
  if (!configurado) return true;
  const host = String(hostname || "").toLowerCase();
  return configurado.split(",").map(function (item) {
    return item.trim().toLowerCase();
  }).filter(Boolean).some(function (permitido) {
    if (permitido === "*") return true;
    if (permitido.startsWith("*.")) {
      const sufixo = permitido.slice(1);
      return host === permitido.slice(2) || host.endsWith(sufixo);
    }
    return host === permitido || host.endsWith("." + permitido);
  });
}

function validarAlvo(valor, env) {
  let alvo;
  try {
    alvo = new URL(valor);
  } catch (erro) {
    throw new Error("URL inválida.");
  }
  if (alvo.protocol !== "http:" && alvo.protocol !== "https:") {
    throw new Error("Somente URLs HTTP/HTTPS são permitidas.");
  }
  if (hostBloqueado(alvo.hostname)) {
    throw new Error("Destino bloqueado por segurança (rede local/privada).");
  }
  if (!hostPermitido(alvo.hostname, env)) {
    throw new Error("Host não autorizado neste proxy.");
  }
  return alvo;
}

function urlDoProxy(request, destino) {
  const base = new URL(request.url);
  return base.origin + base.pathname + "?url=" + encodeURIComponent(destino);
}

function sanitizarDestino(valor) {
  return String(valor || "").replace(/([?&](?:password|pass|username|user|token)=)[^&]*/gi, "$1******");
}

function reescreverPlaylistHls(texto, alvo, request) {
  function resolverUri(uri) {
    const valor = String(uri || "").trim();
    if (!valor || /^(data:|blob:|#)/i.test(valor)) return valor;
    let absoluta;
    try {
      absoluta = new URL(valor, alvo).href;
    } catch (erro) {
      return valor;
    }
    if (!/^https?:\/\//i.test(absoluta)) return valor;
    return urlDoProxy(request, absoluta);
  }

  return texto.split(/\r?\n/).map(function (linha) {
    const limpa = linha.trim();
    if (!limpa) return linha;

    if (limpa.charAt(0) === "#") {
      // Reescreve atributos URI="..." de chaves, mapas, mídias, partes, etc.
      return linha.replace(/URI="([^"]*)"/gi, function (original, uri) {
        return 'URI="' + resolverUri(uri) + '"';
      });
    }

    // Linhas de URI (segmentos e sub-playlists declaradas após #EXT-X-STREAM-INF).
    return resolverUri(limpa);
  }).join("\n");
}

function urlPareceListaM3u(alvo, contentType) {
  const tipo = String(contentType || "").toLowerCase();
  const caminho = String(alvo.pathname || "").toLowerCase();
  const busca = String(alvo.search || "").toLowerCase();
  // Um manifesto HLS (.m3u8) tem prioridade mesmo que a query seja estranha.
  if (/\.m3u8$/.test(caminho)) return false;
  // Download de catálogo M3U/M3U+ (get.php?...type=m3u_plus). Pode ter
  // centenas de MB e nunca deve ser bufferizado no proxy.
  if (/(?:^|[?&])type=m3u(?:[_-]?plus)?(?:&|$)/.test(busca)) return true;
  // Alguns provedores usam .m3u (sem o 8) para manifestos HLS. Nesse caso o
  // Content-Type mpegurl indica que é um manifesto pequeno, não um catálogo.
  if (/\.m3u$/.test(caminho)) return !/mpegurl/.test(tipo);
  return false;
}

function deveLerComoTexto(contentType, alvo) {
  const tipo = String(contentType || "").toLowerCase();
  const caminho = String(alvo.pathname || "").toLowerCase();

  // Lista de catálogo: streaming puro, independentemente do Content-Type.
  if (urlPareceListaM3u(alvo, tipo)) return false;

  // Manifestos HLS são pequenos e precisam ser reescritos para passar pelo proxy.
  if (/\.m3u8$/.test(caminho) || /mpegurl/.test(tipo)) return true;

  // JSON/XML de APIs não precisa ser reescrito: segue em streaming direto.
  if (/application\/(?:json|xml)/i.test(tipo)) return false;

  // Texto puro pode ser um manifesto HLS servido sem extensão .m3u8.
  if (/text\//i.test(tipo)) return true;
  return false;
}

async function lerTextoComLimite(upstream, limite) {
  if (!upstream.body || typeof upstream.body.getReader !== "function") {
    return { texto: await upstream.text(), stream: null, excedeu: false };
  }

  const leitor = upstream.body.getReader();
  const pedacos = [];
  const decodificador = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
  let recebidos = 0;

  while (true) {
    const leitura = await leitor.read();
    if (leitura.done) break;
    if (!leitura.value || !leitura.value.byteLength) continue;
    recebidos += leitura.value.byteLength;

    if (recebidos > limite) {
      // Já leu mais que o limite: devolve os bytes lidos (incluindo este
      // pedaço) + o restante em streaming, sem carregar o arquivo inteiro.
      pedacos.push(leitura.value);
      let indice = 0;
      const corpo = new ReadableStream({
        async pull(controller) {
          if (indice < pedacos.length) {
            controller.enqueue(pedacos[indice]);
            indice += 1;
            return;
          }
          const proximo = await leitor.read();
          if (proximo.done) {
            controller.close();
            return;
          }
          if (proximo.value && proximo.value.byteLength) controller.enqueue(proximo.value);
        },
        cancel(motivo) {
          try { leitor.cancel(motivo); } catch (erro) {}
        }
      });
      return { texto: null, stream: corpo, excedeu: true };
    }

    pedacos.push(leitura.value);
  }

  if (decodificador) {
    const bytes = new Uint8Array(recebidos);
    let offset = 0;
    pedacos.forEach(function (pedaco) {
      bytes.set(pedaco, offset);
      offset += pedaco.byteLength;
    });
    return { texto: decodificador.decode(bytes), stream: null, excedeu: false };
  }

  const texto = pedacos.map(function (pedaco) {
    return String.fromCharCode.apply(null, pedaco);
  }).join("");
  return { texto: texto, stream: null, excedeu: false };
}

function cabecalhosResposta(upstream, cors, tipoConteudo) {
  const headers = new Headers();
  const permitidos = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
    "date",
    "cache-control",
    "expires"
  ];
  permitidos.forEach(function (nome) {
    const valor = upstream.headers.get(nome);
    if (valor) headers.set(nome, valor);
  });
  // Se o runtime descomprimir o corpo, o Content-Length original deixa de
  // corresponder ao tamanho entregue ao navegador.
  const codificacao = upstream.headers.get("content-encoding");
  if (codificacao && !/^identity$/i.test(codificacao)) headers.delete("content-length");
  if (tipoConteudo) headers.set("content-type", tipoConteudo);
  Object.keys(cors).forEach(function (nome) {
    headers.set(nome, cors[nome]);
  });
  return headers;
}

async function buscarComRedirecionamentos(alvo, request, env) {
  let atual = alvo;
  const metodo = request.method === "HEAD" ? "HEAD" : "GET";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
      const headers = new Headers();
      const range = request.headers.get("Range");
      const ifRange = request.headers.get("If-Range");
      if (range) headers.set("Range", range);
      if (ifRange) headers.set("If-Range", ifRange);
      headers.set("Accept", request.headers.get("Accept") || "*/*");
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HMS-TV/1.0");

      const resposta = await fetch(atual.href, {
        method: metodo,
        headers: headers,
        redirect: "manual",
        signal: controller.signal
      });

      if (resposta.status >= 300 && resposta.status < 400) {
        const local = resposta.headers.get("Location");
        if (!local) return { resposta: resposta, alvo: atual };
        if (i === MAX_REDIRECTS) throw new Error("Muitos redirecionamentos.");
        const proximo = new URL(local, atual);
        validarAlvo(proximo.href, env);
        atual = proximo;
        continue;
      }

      return { resposta: resposta, alvo: atual };
    }
    throw new Error("Muitos redirecionamentos.");
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const corsInfo = resolverCors(request, env);
  const cors = corsInfo.headers;

  if (request.method === "OPTIONS") {
    if (!corsInfo.permitido) return jsonResponse(403, { error: "Origem não autorizada." }, cors);
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(405, { error: "Método não permitido. Use GET." }, cors);
  }

  const url = new URL(request.url);
  const destino = url.searchParams.get("url") || url.searchParams.get("quest") || url.searchParams.get("u");
  if (!destino) {
    return jsonResponse(400, { error: "Parâmetro 'url' ausente.", details: "Informe ?url=<endereço completo>" }, cors);
  }

  let alvo;
  try {
    alvo = validarAlvo(destino, env);
  } catch (erro) {
    return jsonResponse(400, { error: erro.message, details: erro.message }, cors);
  }

  try {
    const resultado = await buscarComRedirecionamentos(alvo, request, env);
    const upstream = resultado.resposta;
    const tipoOriginal = upstream.headers.get("content-type") || "";
    const headers = cabecalhosResposta(upstream, cors, null);

    // HEAD não precisa consumir o corpo e preserva os cabeçalhos originais.
    if (request.method === "HEAD") {
      return new Response(null, { status: upstream.status, headers: headers });
    }

    const deveLerTexto = deveLerComoTexto(tipoOriginal, resultado.alvo);

    if (deveLerTexto) {
      const leitura = await lerTextoComLimite(upstream, MAX_TEXTO_BYTES);

      // Conteúdo maior que o limite: repassa o que já foi lido + o restante
      // em streaming (usado para listas M3U grandes servidas como texto).
      if (leitura.texto === null) {
        headers.delete("Content-Length");
        return new Response(leitura.stream, {
          status: upstream.status,
          headers: headers
        });
      }

      const texto = leitura.texto;
      if (/#EXT-X-/i.test(texto)) {
        const reescrito = reescreverPlaylistHls(texto, resultado.alvo, request);
        headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        headers.delete("Content-Length");
        headers.set("Cache-Control", "no-store");
        return new Response(reescrito, {
          status: upstream.status,
          headers: headers
        });
      }
      headers.delete("Content-Length");
      return new Response(texto, {
        status: upstream.status,
        headers: headers
      });
    }

    // Listas M3U grandes e conteúdo binário (segmentos .ts, MP4, imagens etc.):
    // o body é repassado em streaming e o status 206/Range é preservado.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: headers
    });
  } catch (erro) {
    const abortado = erro && erro.name === "AbortError";
    const mensagem = abortado
      ? "O servidor de origem demorou demais para responder."
      : (erro && erro.message ? erro.message : "Falha ao acessar o servidor de origem.");
    console.error("Proxy HMS-TV:", mensagem, sanitizarDestino(destino));
    return jsonResponse(abortado ? 504 : 502, {
      error: "Falha no proxy.",
      details: mensagem
    }, cors);
  }
}
