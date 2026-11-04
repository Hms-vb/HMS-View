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
 *  - Converte destinos com IP literal para um hostname DNS público
 *    (sslip.io/nip.io), pois o fetch do Cloudflare Workers recusa IP direto.
 *  - Proteção básica contra SSRF (bloqueia localhost e faixas privadas).
 *
 * Variáveis de ambiente opcionais (Cloudflare Pages > Settings > Variables):
 *  - ALLOWED_HOSTS: lista separada por vírgula. Ex.: "meuservidor.com,*.iptv.com"
 *  - ALLOWED_ORIGINS: lista separada por vírgula. Ex.: "https://meusite.pages.dev"
 */

import { connect } from "cloudflare:sockets";

const TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 4;
// Playlists M3U de catálogo podem ter centenas de MB. Só lemos como texto
// manifestos HLS e respostas pequenas; acima deste limite o corpo é repassado
// em streaming para não estourar a memória das Functions (~128 MB).
const MAX_TEXTO_BYTES = 4 * 1024 * 1024;

// O provedor deste catálogo bloqueia User-Agent de navegador na API
// (player_api.php) e no get.php. A ordem abaixo tenta primeiro UAs de player
// (mais compatíveis com Xtream Codes) e deixa o UA de navegador como último
// recurso, para não quebrar provedores que só aceitam navegador.
const USER_AGENTS = [
  "VLC/3.0.21 LibVLC/3.0.21",
  "IPTVSmarters/1.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
];
const PLAYER_UA = USER_AGENTS[0];
const TENTATIVAS_API = USER_AGENTS.length;
const ESPERA_ENTRE_TENTATIVAS_MS = 800;
const CACHE_API_TTL_MS = 5 * 60 * 1000;
const CACHE_API_MAX_BYTES = 24 * 1024 * 1024;

function esperar(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function ehApiXtream(alvo) {
  return /\/player_api\.php$/i.test(String((alvo && alvo.pathname) || ""));
}

function respostaTransitoria(resposta) {
  if (!resposta) return false;
  const status = resposta.status;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true;
  // O provedor devolve 200 com corpo vazio quando está limitando requisições.
  if (status === 200 && resposta.headers.get("content-length") === "0") return true;
  return false;
}

// Cache em memória para não baixar o catálogo inteiro de novo quando o
// usuário repete o login ou o app tenta novamente.
const cacheApi = new Map();
let cacheApiBytes = 0;

function lerCacheApi(chave) {
  const item = cacheApi.get(chave);
  if (!item) return null;
  if (Date.now() - item.tempo > CACHE_API_TTL_MS) {
    cacheApi.delete(chave);
    cacheApiBytes -= item.dados.buffer.byteLength;
    return null;
  }
  return item.dados;
}

function gravarCacheApi(chave, dados) {
  const tamanho = dados.buffer.byteLength;
  if (!tamanho || tamanho > CACHE_API_MAX_BYTES / 2) return;
  const anterior = cacheApi.get(chave);
  if (anterior) cacheApiBytes -= anterior.dados.buffer.byteLength;
  cacheApi.set(chave, { tempo: Date.now(), dados: dados });
  cacheApiBytes += tamanho;
  while (cacheApiBytes > CACHE_API_MAX_BYTES && cacheApi.size > 1) {
    const primeira = cacheApi.keys().next().value;
    if (primeira === chave) break;
    const item = cacheApi.get(primeira);
    cacheApi.delete(primeira);
    if (item) cacheApiBytes -= item.dados.buffer.byteLength;
  }
}

function respostaDeDados(dados) {
  return {
    resposta: new Response(dados.buffer, {
      status: dados.status,
      headers: {
        "content-type": dados.contentType,
        "content-length": String(dados.buffer.byteLength)
      }
    }),
    alvo: dados.alvo
  };
}

async function buscarApi(alvo, request, env) {
  const chave = alvo.href;
  const emCache = lerCacheApi(chave);
  if (emCache) return respostaDeDados(emCache);

  let ultimaResposta = null;
  let ultimoErro = null;

  for (let tentativa = 0; tentativa < TENTATIVAS_API; tentativa += 1) {
    if (tentativa > 0) await esperar(ESPERA_ENTRE_TENTATIVAS_MS * tentativa);
    const userAgent = USER_AGENTS[tentativa] || PLAYER_UA;

    try {
      const resultado = await buscarComRedirecionamentos(alvo, request, env, userAgent);
      const resposta = resultado.resposta;

      if (respostaTransitoria(resposta) && tentativa < TENTATIVAS_API - 1) {
        ultimaResposta = resultado;
        try { await resposta.body.cancel(); } catch (erro) {}
        continue;
      }

      const buffer = await resposta.arrayBuffer();
      if (!buffer.byteLength && tentativa < TENTATIVAS_API - 1) {
        ultimaResposta = resultado;
        continue;
      }

      const dados = {
        status: resposta.status,
        contentType: resposta.headers.get("content-type") || "application/json; charset=utf-8",
        buffer: buffer,
        alvo: resultado.alvo
      };
      if (resposta.status === 200 && buffer.byteLength > 0) gravarCacheApi(chave, dados);
      return respostaDeDados(dados);
    } catch (erro) {
      ultimoErro = erro;
      // Se o provedor demorou demais, outra tentativa só aumentaria o tempo
      // total e poderia estourar o limite da Function.
      if (erro && erro.name === "AbortError") throw erro;
      if (tentativa === TENTATIVAS_API - 1) throw erro;
    }
  }

  if (ultimaResposta) {
    try {
      const buffer = await ultimaResposta.resposta.arrayBuffer();
      return respostaDeDados({
        status: ultimaResposta.resposta.status,
        contentType: ultimaResposta.resposta.headers.get("content-type") || "application/json; charset=utf-8",
        buffer: buffer,
        alvo: ultimaResposta.alvo
      });
    } catch (erro) {}
  }

  throw ultimoErro || new Error("Falha ao acessar a API do provedor.");
}

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
  const ipOculto = ipEmHostWildcard(host);
  if (ipOculto && ipv4Privado(ipOculto)) return true;
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

function ipv4Literal(hostname) {
  const partes = String(hostname || "").split(".");
  if (partes.length !== 4) return null;
  const numeros = partes.map(function (parte) { return Number(parte); });
  if (numeros.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return null;
  return numeros.join(".");
}

function ipEmHostWildcard(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const match = host.match(/^(.+)\.(nip\.io|sslip\.io)$/);
  if (!match) return null;
  const partes = match[1].split(/[.-]/).filter(Boolean);
  if (partes.length !== 4) return null;
  return ipv4Literal(partes.join("."));
}

function urlComHostDns(url, hostname) {
  const copia = new URL(url.href);
  copia.hostname = hostname;
  return copia;
}

function hostsDnsParaIp(url) {
  // O fetch do Cloudflare Workers recusa IP literal (erro 1003). Hostnames
  // públicos que resolvem para o mesmo IP contornam essa restrição.
  if (url.protocol !== "http:") return [url];
  const ip = ipv4Literal(url.hostname);
  if (!ip) return [url];
  const partes = ip.split(".");
  return [
    urlComHostDns(url, partes.join("-") + ".sslip.io"),
    urlComHostDns(url, partes.join(".") + ".nip.io")
  ];
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

function juntarBytes(partes) {
  let total = 0;
  for (const parte of partes) total += parte.byteLength;
  const juntas = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    juntas.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return juntas;
}

function indiceFimCabecalhos(bytes) {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function analisarCabecalhos(texto) {
  const linhas = texto.split("\r\n");
  const linhaStatus = linhas.shift() || "";
  const partes = linhaStatus.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i);
  if (!partes) throw new Error("Resposta HTTP inválida do servidor de origem.");

  const headers = new Headers();
  for (const linha of linhas) {
    if (!linha) continue;
    const separador = linha.indexOf(":");
    if (separador <= 0) continue;
    const nome = linha.slice(0, separador).trim();
    const valor = linha.slice(separador + 1).trim();
    // Set-Cookie não é necessário para o player e evita repassar cookies do
    // provedor para o navegador.
    if (!nome || /^set-cookie$/i.test(nome)) continue;
    try { headers.append(nome, valor); } catch (erro) {}
  }

  return {
    status: Number(partes[1]),
    statusText: partes[2] || "",
    headers: headers
  };
}

function comPrazo(promessa, ms) {
  let timer = null;
  const limite = new Promise(function (resolver, rejeitar) {
    timer = setTimeout(function () {
      const erro = new Error("O servidor de origem demorou demais para responder.");
      erro.name = "AbortError";
      rejeitar(erro);
    }, Math.max(1, ms));
  });
  return Promise.race([promessa, limite]).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

async function lerCabecalhosSocket(leitor) {
  let buffer = new Uint8Array(0);
  while (true) {
    const leitura = await leitor.read();
    if (leitura.done) throw new Error("Conexão encerrada antes dos cabeçalhos.");
    if (leitura.value && leitura.value.byteLength) {
      buffer = juntarBytes([buffer, leitura.value]);
    }
    const fim = indiceFimCabecalhos(buffer);
    if (fim >= 0) {
      const texto = new TextDecoder("iso-8859-1").decode(buffer.slice(0, fim));
      const dados = analisarCabecalhos(texto);
      dados.resto = buffer.slice(fim + 4);
      return dados;
    }
    if (buffer.byteLength > 64 * 1024) {
      throw new Error("Cabeçalhos grandes demais na resposta de origem.");
    }
  }
}

async function finalizarSocket(socket, leitor) {
  try { if (leitor) await leitor.cancel(); } catch (erro) {}
  try { if (socket) await socket.close(); } catch (erro) {}
}

function criarCorpoSocket(socket, leitor, resto, headers, prazoRestante) {
  const codificacao = String(headers.get("transfer-encoding") || "").toLowerCase();
  const chunked = /\bchunked\b/.test(codificacao);
  const comprimentoTexto = headers.get("content-length");
  const comprimento = comprimentoTexto === null ? NaN : Number(comprimentoTexto);
  let restante = Number.isFinite(comprimento) && comprimento >= 0 ? comprimento : null;
  let buffer = resto && resto.byteLength ? resto : new Uint8Array(0);
  let finalizado = false;

  async function finalizar() {
    if (finalizado) return;
    finalizado = true;
    await finalizarSocket(socket, leitor);
  }

  async function lerMais() {
    while (true) {
      const leitura = await comPrazo(leitor.read(), prazoRestante());
      if (leitura.done) return false;
      if (leitura.value && leitura.value.byteLength) {
        buffer = juntarBytes([buffer, leitura.value]);
        return true;
      }
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        if (chunked) {
          while (true) {
            let fimLinha = -1;
            for (let i = 0; i + 1 < buffer.length; i += 1) {
              if (buffer[i] === 13 && buffer[i + 1] === 10) {
                fimLinha = i;
                break;
              }
            }
            if (fimLinha < 0) {
              if (!(await lerMais())) {
                controller.error(new Error("Resposta chunked incompleta."));
                await finalizar();
                return;
              }
              continue;
            }

            const linha = new TextDecoder("iso-8859-1").decode(buffer.slice(0, fimLinha));
            const tamanho = parseInt(linha.split(";")[0].trim(), 16);
            if (!Number.isFinite(tamanho) || tamanho < 0) {
              throw new Error("Bloco chunked inválido.");
            }
            if (tamanho === 0) {
              controller.close();
              await finalizar();
              return;
            }

            const inicioDados = fimLinha + 2;
            if (buffer.length < inicioDados + tamanho + 2) {
              if (!(await lerMais())) {
                controller.error(new Error("Resposta chunked incompleta."));
                await finalizar();
                return;
              }
              continue;
            }

            const dados = buffer.slice(inicioDados, inicioDados + tamanho);
            buffer = buffer.slice(inicioDados + tamanho + 2);
            controller.enqueue(dados);
            return;
          }
        }

        if (restante !== null) {
          if (restante === 0) {
            controller.close();
            await finalizar();
            return;
          }
          if (!buffer.byteLength && !(await lerMais())) {
            controller.error(new Error("Conexão encerrada antes do corpo completo."));
            await finalizar();
            return;
          }
          const quantidade = Math.min(buffer.byteLength, restante);
          const pedaco = buffer.slice(0, quantidade);
          buffer = buffer.slice(quantidade);
          restante -= quantidade;
          controller.enqueue(pedaco);
          if (restante === 0) {
            controller.close();
            await finalizar();
          }
          return;
        }

        // Sem Content-Length e sem chunked: lê até o servidor fechar.
        if (!buffer.byteLength && !(await lerMais())) {
          controller.close();
          await finalizar();
          return;
        }
        const pedaco = buffer;
        buffer = new Uint8Array(0);
        controller.enqueue(pedaco);
      } catch (erro) {
        controller.error(erro);
        await finalizar();
      }
    },
    async cancel() {
      await finalizar();
    }
  });
}

async function buscarViaSocket(alvo, request, userAgent) {
  const seguro = alvo.protocol === "https:";
  const porta = Number(alvo.port || (seguro ? 443 : 80));
  const metodo = request.method === "HEAD" ? "HEAD" : "GET";
  const inicio = Date.now();
  const prazoRestante = function () {
    return Math.max(1000, TIMEOUT_MS - (Date.now() - inicio));
  };

  const socket = connect(
    { hostname: alvo.hostname.replace(/^\[|\]$/g, ""), port: porta },
    seguro ? { secureTransport: "on" } : undefined
  );
  let leitor = null;
  let concluido = false;

  try {
    const escritor = socket.writable.getWriter();
    const linhas = [
      metodo + " " + (alvo.pathname || "/") + (alvo.search || "") + " HTTP/1.1",
      "Host: " + alvo.host,
      "User-Agent: " + (userAgent || PLAYER_UA),
      "Accept: " + (request.headers.get("Accept") || "*/*"),
      "Accept-Language: pt-BR,pt;q=0.9,en;q=0.8",
      "Accept-Encoding: identity",
      "Connection: close"
    ];
    const range = request.headers.get("Range");
    const ifRange = request.headers.get("If-Range");
    if (range) linhas.push("Range: " + range);
    if (ifRange) linhas.push("If-Range: " + ifRange);
    linhas.push("", "");

    await comPrazo(escritor.write(new TextEncoder().encode(linhas.join("\r\n"))), prazoRestante());
    escritor.releaseLock();

    leitor = socket.readable.getReader();
    const cabecalho = await comPrazo(lerCabecalhosSocket(leitor), prazoRestante());
    const semCorpo = metodo === "HEAD" || cabecalho.status === 204 ||
      cabecalho.status === 304 || (cabecalho.status >= 100 && cabecalho.status < 200);

    if (semCorpo) {
      await finalizarSocket(socket, leitor);
      concluido = true;
      return {
        resposta: new Response(null, {
          status: cabecalho.status,
          statusText: cabecalho.statusText,
          headers: cabecalho.headers
        }),
        alvo: alvo
      };
    }

    const corpo = criarCorpoSocket(socket, leitor, cabecalho.resto, cabecalho.headers, prazoRestante);
    const resposta = new Response(corpo, {
      status: cabecalho.status,
      statusText: cabecalho.statusText,
      headers: cabecalho.headers
    });
    concluido = true;
    return { resposta: resposta, alvo: alvo };
  } finally {
    if (!concluido) await finalizarSocket(socket, leitor);
  }
}

async function buscarViaFetch(alvo, request, env, userAgent) {
  const headers = new Headers();
  const range = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (range) headers.set("Range", range);
  if (ifRange) headers.set("If-Range", ifRange);
  headers.set("Accept", request.headers.get("Accept") || "*/*");
  headers.set("User-Agent", userAgent || PLAYER_UA);

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  try {
    const candidatos = hostsDnsParaIp(alvo);
    let resposta = null;
    let respostaBloqueada = null;
    let ultimoErro = null;

    for (let c = 0; c < candidatos.length; c += 1) {
      try {
        const tentativa = await fetch(candidatos[c].href, {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          headers: headers,
          redirect: "manual",
          signal: controller.signal
        });
        // 403/530 é o que o Cloudflare devolve ao buscar IP literal.
        // Tenta o próximo hostname DNS antes de desistir.
        if (c < candidatos.length - 1 && (tentativa.status === 403 || tentativa.status === 530)) {
          if (!respostaBloqueada) respostaBloqueada = tentativa;
          continue;
        }
        resposta = tentativa;
        break;
      } catch (erro) {
        ultimoErro = erro;
      }
    }

    if (!resposta) resposta = respostaBloqueada;
    if (!resposta) throw ultimoErro || new Error("Falha ao acessar o servidor de origem.");
    return { resposta: resposta, alvo: alvo };
  } finally {
    clearTimeout(timer);
  }
}

async function buscarHttp(alvo, request, env, userAgent) {
  // O fetch do Workers adiciona cabeçalhos Cf-* que alguns provedores usam
  // para bloquear a requisição. Em HTTP puro, o socket TCP fala direto com a
  // origem e contorna esse bloqueio. HTTPS segue pelo fetch normal.
  if (alvo.protocol === "http:") {
    let resultadoSocket = null;
    try {
      resultadoSocket = await buscarViaSocket(alvo, request, userAgent);
    } catch (erro) {
      if (erro && erro.name === "AbortError") throw erro;
      // Socket indisponível: tenta o fetch normal como alternativa.
      return await buscarViaFetch(alvo, request, env, userAgent);
    }

    // Se a origem recusar a requisição HTTP/1.1 crua (comum em servidores que
    // exigem cabeçalhos específicos), tenta o fetch normal antes de desistir.
    const status = resultadoSocket.resposta.status;
    const valeTentarFetch = status === 400 || status === 403 || status === 405 ||
      status === 501 || status === 505;
    if (!valeTentarFetch) return resultadoSocket;

    try {
      const resultadoFetch = await buscarViaFetch(alvo, request, env, userAgent);
      try { if (resultadoSocket.resposta.body) await resultadoSocket.resposta.body.cancel(); } catch (erro) {}
      return resultadoFetch;
    } catch (erro) {
      if (erro && erro.name === "AbortError") throw erro;
      return resultadoSocket;
    }
  }
  return await buscarViaFetch(alvo, request, env, userAgent);
}

async function buscarComRedirecionamentos(alvo, request, env, userAgent) {
  let atual = alvo;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const resultado = await buscarHttp(atual, request, env, userAgent);
    const resposta = resultado.resposta;

    if (resposta.status >= 300 && resposta.status < 400) {
      const local = resposta.headers.get("Location");
      if (!local) return { resposta: resposta, alvo: atual };
      try { if (resposta.body) await resposta.body.cancel(); } catch (erro) {}
      if (i === MAX_REDIRECTS) throw new Error("Muitos redirecionamentos.");
      const proximo = new URL(local, atual);
      validarAlvo(proximo.href, env);
      atual = proximo;
      continue;
    }

    return { resposta: resposta, alvo: atual };
  }

  throw new Error("Muitos redirecionamentos.");
}

async function buscarComFallbackUa(alvo, request, env) {
  let ultimaResposta = null;
  let ultimoErro = null;

  for (let tentativa = 0; tentativa < USER_AGENTS.length; tentativa += 1) {
    if (tentativa > 0) await esperar(400 * tentativa);
    try {
      const resultado = await buscarComRedirecionamentos(alvo, request, env, USER_AGENTS[tentativa]);
      const resposta = resultado.resposta;
      const transitoria = resposta.status === 401 || resposta.status === 403 ||
        resposta.status === 429 || resposta.status >= 500;

      if (transitoria && tentativa < USER_AGENTS.length - 1) {
        ultimaResposta = resultado;
        try { await resposta.body.cancel(); } catch (erro) {}
        continue;
      }

      return resultado;
    } catch (erro) {
      ultimoErro = erro;
      if (erro && erro.name === "AbortError") throw erro;
      if (tentativa === USER_AGENTS.length - 1) throw erro;
    }
  }

  if (ultimaResposta) return ultimaResposta;
  throw ultimoErro || new Error("Falha ao acessar o servidor de origem.");
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
    const resultado = ehApiXtream(alvo) && request.method === "GET"
      ? await buscarApi(alvo, request, env)
      : await buscarComFallbackUa(alvo, request, env);
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
