const input = document.getElementById("arquivoExcel");
const btnUploadTrigger = document.getElementById("btnUploadTrigger");
const btnLimpar = document.getElementById("btnLimpar");
const painel = document.getElementById("painel");

// Elementos de KPI
const kpiDocas = document.getElementById("kpi-docas");
const kpiPedidos = document.getElementById("kpi-pedidos");
const kpiCubagem = document.getElementById("kpi-cubagem");

// --- Senha de administração: único lugar para trocar. Também usada pelo cronometro.js ---
const SENHA_ADMIN = "9704";
window.conferirSenhaAdmin = (digitada) => digitada === SENHA_ADMIN;

// --- Modo operação (botões do cronômetro) e abas ---
// O modo fica guardado no próprio aparelho: o tablet do encarregado liga uma vez e continua assim.
const CHAVE_MODO = "darnel_modo_operacao";
const btnModoOperacao = document.getElementById("btnModoOperacao");
let modoOperacao = false;
let abaAtual = "painel";
let precisaSincronizarScroll = false;

try {
  modoOperacao = localStorage.getItem(CHAVE_MODO) === "1";
} catch (e) {
  console.warn("Não foi possível ler o modo salvo:", e);
}

function aplicarModoOperacao() {
  document.body.classList.toggle("modo-operacao", modoOperacao);
  btnModoOperacao.classList.toggle("ativo", modoOperacao);
  btnModoOperacao.setAttribute("aria-pressed", String(modoOperacao));
  btnModoOperacao.textContent = modoOperacao ? "✅ Operando" : "🖐 Modo operação";
}

btnModoOperacao.addEventListener("click", async () => {
  // Ligar o modo exige a senha; desligar não
  if (!modoOperacao) {
    if (!window.Cronometro) {
      alert("Os cronômetros não carregaram. Verifique a internet e abra a página pelo endereço do site.");
      return;
    }
    const liberado = await window.Cronometro.pedirSenha("🖐 Modo operação", "Libera os botões do cronômetro neste aparelho.");
    if (!liberado) return;
  }

  modoOperacao = !modoOperacao;
  try {
    localStorage.setItem(CHAVE_MODO, modoOperacao ? "1" : "0");
  } catch (e) {
    console.warn("Não foi possível salvar o modo:", e);
  }
  aplicarModoOperacao();
  // Com o modo desligado as abas somem: volta sempre para o Painel
  if (!modoOperacao) mostrarAba("painel");
});

aplicarModoOperacao();

function mostrarAba(nome) {
  abaAtual = nome;
  document.querySelectorAll(".aba").forEach((el) => {
    el.hidden = el.id !== `aba-${nome}`;
  });
  document.querySelectorAll(".aba-btn").forEach((b) => {
    const ativa = b.dataset.aba === nome;
    b.classList.toggle("ativa", ativa);
    b.setAttribute("aria-selected", String(ativa));
  });
  window.scrollTo(0, 0);
  precisaSincronizarScroll = true;
}

document.querySelectorAll(".aba-btn").forEach((b) => {
  b.addEventListener("click", () => mostrarAba(b.dataset.aba));
});

// Regra do auto-scroll (TV): só rola na aba Painel e com o modo operação desligado.
// Continua rolando mesmo com cliente carregando. Troque para true se quiser parar nesse caso.
const PARAR_SCROLL_COM_CARREGAMENTO = false;

function autoScrollPermitido() {
  if (modoOperacao) return false;
  if (abaAtual !== "painel") return false;
  if (PARAR_SCROLL_COM_CARREGAMENTO && window.Cronometro && window.Cronometro.carregando() > 0) return false;
  return true;
}

// --- Configuração do JSONBin.io ---
const JSONBIN_ID = "6aede7adffd5d16053ac4cbb";
const JSONBIN_KEY = "$2a$10$NoRCHe7AN8E83aWAYYlLjezhxxRQIK.SgXLTxNAU.3kACcz3S3SCO"; // Access Key com permissão Read + Update
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;
const CHAVE_CACHE = "darnel_dados_docas"; // cópia local usada apenas como reserva (se ficar sem internet)

// Se você usar a Master Key em vez da Access Key, troque "X-Access-Key" por "X-Master-Key"
function cabecalhosJsonBin(comCorpo) {
  const h = { "X-Access-Key": JSONBIN_KEY };
  if (comCorpo) h["Content-Type"] = "application/json";
  return h;
}

async function carregarDadosNuvem() {
  const resp = await fetch(`${JSONBIN_URL}/latest`, {
    method: "GET",
    headers: { ...cabecalhosJsonBin(false), "X-Bin-Meta": "false" },
    cache: "no-store"
  });
  if (!resp.ok) throw new Error(`Erro ao ler JSONBin (HTTP ${resp.status})`);

  const json = await resp.json();
  // Aceita tanto { dados: [...] } quanto um array direto
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.dados)) return json.dados;
  return [];
}

async function salvarDadosNuvem(dados) {
  const resp = await fetch(JSONBIN_URL, {
    method: "PUT",
    headers: cabecalhosJsonBin(true),
    body: JSON.stringify({
      dados: dados,
      atualizadoEm: new Date().toISOString()
    })
  });
  if (!resp.ok) throw new Error(`Erro ao gravar no JSONBin (HTTP ${resp.status})`);
}

btnUploadTrigger.addEventListener("click", () => {
  const senhaDigitada = prompt("Digite a senha de administração para carregar a planilha:");
  if (senhaDigitada === null) return;

  if (window.conferirSenhaAdmin(senhaDigitada)) {
    input.click();
  } else {
    alert("Senha incorreta! Acesso negado.");
  }
});

input.addEventListener("change", lerArquivo);

btnLimpar.addEventListener("click", async () => {
  const senhaDigitada = prompt("Digite a senha de administração para limpar os dados:");
  if (senhaDigitada === null) return;

  if (window.conferirSenhaAdmin(senhaDigitada)) {
    try {
      await salvarDadosNuvem([]);
      localStorage.removeItem(CHAVE_CACHE);
      alert("Dados limpos com sucesso para todos os computadores!");
      location.reload();
    } catch (e) {
      console.error(e);
      alert("Não foi possível limpar os dados na nuvem. Verifique a internet e a chave do JSONBin.");
    }
  } else {
    alert("Senha incorreta! Ação negada.");
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const dados = await carregarDadosNuvem();
    // Guarda uma cópia local como reserva
    try {
      localStorage.setItem(CHAVE_CACHE, JSON.stringify(dados));
    } catch (e) {
      console.warn("Não foi possível salvar a cópia local:", e);
    }
    gerarPainel(dados);
  } catch (e) {
    console.error("Erro ao carregar dados da nuvem:", e);

    // Sem internet ou erro no JSONBin: usa a última cópia local
    const dadosSalvos = localStorage.getItem(CHAVE_CACHE);
    if (dadosSalvos) {
      try {
        gerarPainel(JSON.parse(dadosSalvos));
      } catch (err) {
        console.error("Erro ao carregar dados salvos:", err);
        localStorage.removeItem(CHAVE_CACHE);
      }
    }
  }
});

function lerArquivo(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  const reader = new FileReader();

  reader.onload = async function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });

    const aba = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(aba);

    try {
      localStorage.setItem(CHAVE_CACHE, JSON.stringify(dados));
    } catch (err) {
      console.warn("Não foi possível salvar a cópia local:", err);
    }

    gerarPainel(dados);

    try {
      await salvarDadosNuvem(dados);
      alert("Planilha enviada com sucesso! Pressione F5 nos demais computadores para atualizar.");
    } catch (err) {
      console.error(err);
      alert("A planilha foi carregada apenas neste computador. Não foi possível enviar para a nuvem. Verifique a internet e a chave do JSONBin.");
    }

    // Permite reenviar o mesmo arquivo depois, se necessário
    input.value = "";
  };

  reader.readAsArrayBuffer(arquivo);
}

function extrairNumeroDoca(texto) {
  if (!texto) return "";
  const match = String(texto).match(/\d+/);
  if (!match) return "";
  const num = parseInt(match[0], 10);
  if (num >= 1 && num <= 38) {
    return String(num).padStart(2, "0");
  }
  return "";
}

// Protege o HTML contra caracteres especiais vindos da planilha
function escHtml(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function gerarPainel(dados) {
  painel.innerHTML = "";

  const docasOcupadasMap = {};
  let totalPedidosGeral = 0;
  let totalCubagemGeral = 0;

  dados.forEach((linha) => {
    let docaBruta = linha["Local Stage"] ? String(linha["Local Stage"]).trim() : "";
    if (!docaBruta) return;

    let doca = extrairNumeroDoca(docaBruta);
    if (!doca) return;

    const clienteBruto =
      linha["Comentario Carga"] ||
      linha["Comentário Carga"] ||
      linha["Cliente"] ||
      "Sem Cliente";

    const clienteLimpo = limparCliente(String(clienteBruto));

    const cubagem =
      parseFloat(
        String(linha["Cubagem"] || "0").replace(",", ".")
      ) || 0;

    if (!docasOcupadasMap[doca]) {
      docasOcupadasMap[doca] = {
        clientes: new Set(),
        porCliente: {}, // cubagem e pedidos de cada cliente dentro da doca
        cubagem: 0,
        pedidos: 0,
        ocupada: true
      };
    }

    if (clienteLimpo) {
      docasOcupadasMap[doca].clientes.add(clienteLimpo);

      const pc = docasOcupadasMap[doca].porCliente;
      if (!pc[clienteLimpo]) pc[clienteLimpo] = { cubagem: 0, pedidos: 0 };
      pc[clienteLimpo].cubagem += cubagem;
      pc[clienteLimpo].pedidos++;
    }

    docasOcupadasMap[doca].pedidos++;
    docasOcupadasMap[doca].cubagem += cubagem;

    totalPedidosGeral++;
    totalCubagemGeral += cubagem;
  });

  const docasOcupadasCount = Object.keys(docasOcupadasMap).length;

  kpiDocas.textContent = `${docasOcupadasCount} / 38`;
  kpiPedidos.textContent = totalPedidosGeral;
  kpiCubagem.textContent = `${totalCubagemGeral.toFixed(2)} m³`;

  const listaOcupadas = [];
  const listaLivres = [];

  Object.entries(docasOcupadasMap).forEach(([doca, info]) => {
    listaOcupadas.push({ doca, info });
  });

  for (let i = 1; i <= 38; i++) {
    const nomeDoca = String(i).padStart(2, "0");
    if (!docasOcupadasMap[nomeDoca]) {
      listaLivres.push({
        doca: nomeDoca,
        info: {
          clientes: new Set(),
          porCliente: {},
          cubagem: 0,
          pedidos: 0,
          ocupada: false
        }
      });
    }
  }

  // Ordenação: Vermelhas (>= 100 m³) primeiro, depois Amarelas (< 100 m³)
  listaOcupadas.sort((a, b) => {
    const aCritica = a.info.cubagem >= 100;
    const bCritica = b.info.cubagem >= 100;

    if (aCritica && !bCritica) return -1;
    if (!aCritica && bCritica) return 1;

    return a.doca.localeCompare(b.doca, undefined, { numeric: true });
  });

  listaLivres.sort((a, b) => a.doca.localeCompare(b.doca, undefined, { numeric: true }));

  const listaFinalCards = [...listaOcupadas, ...listaLivres];

  listaFinalCards.forEach(({ doca, info }) => {
    const card = document.createElement("div");

    let classeStatus = "";
    let corStatus = "";

    if (!info.ocupada) {
      classeStatus = "status-card-free";
      corStatus = "var(--status-free)";
    } else if (info.cubagem >= 100) {
      classeStatus = "status-card-critical";
      corStatus = "var(--status-critical)";
    } else {
      classeStatus = "status-card-warning";
      corStatus = "var(--status-warning)";
    }

    card.className = `card ${classeStatus}`;

    const listaClientes = Array.from(info.clientes);

    // Linha de cada cliente, com os dados que o cronômetro precisa
    const htmlCliente = (c) => {
      const pc = info.porCliente[c] || { cubagem: 0, pedidos: 0 };
      return `
        <div class="cliente" data-doca="${doca}" data-cliente="${escHtml(c)}" data-vol="${pc.cubagem.toFixed(3)}" data-ped="${pc.pedidos}">
          <div class="cli-topo">
            <span class="cli-nome">${escHtml(c)}</span>
            <span class="cli-tempo"></span>
          </div>
          <div class="cli-info"></div>
          <div class="cli-ctrl"></div>
        </div>`;
    };

    card.innerHTML = `
      <div class="card-stripe" style="background-color: ${corStatus}"></div>
      <div class="card-header">
        <div class="doca-titulo-container">
          <span class="status-dot" style="background-color: ${corStatus}; box-shadow: 0 0 10px ${corStatus}"></span>
          <h2><span class="doca-palavra">Doca </span>${doca}</h2>
        </div>
        <div class="cabecalho-direita">
          ${
            info.ocupada
              ? `<span class="badge-pedidos">${info.pedidos} ${info.pedidos === 1 ? 'pedido' : 'pedidos'}</span>
                 <span class="total-topo" style="color: ${corStatus}">${info.cubagem.toFixed(2)} m³</span>`
              : `<span class="badge-livre">LIVRE</span>`
          }
        </div>
      </div>

      <div class="card-body">
        <div class="subtitulo-clientes">${info.ocupada ? `Clientes (${listaClientes.length})` : 'Status'}</div>
        ${
          info.ocupada && listaClientes.length > 0
            ? `<div class="doca-progresso"><div class="barra"><i></i></div><span class="txt"></span></div>`
            : ``
        }
        <div class="lista-clientes">
          ${
            info.ocupada
              ? (listaClientes.length > 0
                  ? listaClientes.map(htmlCliente).join("")
                  : `<div class="cliente">Sem cliente especificado</div>`)
              : `<div class="cliente-livre">Doca livre disponível para estufagem</div>`
          }
        </div>
      </div>

      <div class="card-footer">
        <span class="total-label">Volume Total</span>
        <span class="total-valor" style="color: ${corStatus}">${info.cubagem.toFixed(2)} m³</span>
      </div>
    `;

    painel.appendChild(card);
  });

  // Pinta os estados do cronômetro nos cards recém-criados
  if (window.Cronometro) window.Cronometro.aplicar();

  // O auto-scroll decide sozinho, a cada instante, se pode rolar (ver autoScrollPermitido)
  setTimeout(iniciarAutoScrollSuave, 1000);
}

function limparCliente(texto) {
  return texto
    .replace(/\d{2}\/\d{2}\/\d{2,4}/g, "")
    .replace(/\b(FOB|CASC)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Sistema de Auto-Scroll Infinito por Detecção de Fim ---
let animacaoId = null;
let pausadoPorInteracao = false;
let timeoutRetomada = null;
let direcaoScroll = 1; // 1 = descendo, -1 = subindo
let tempoPausaScroll = 0;
let posicaoScroll = 0; // posição controlada por nós (permite valores fracionados)

function obterScrollMaximo() {
  const alturaTotal = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );
  return Math.max(0, alturaTotal - window.innerHeight);
}

function iniciarAutoScrollSuave() {
  if (animacaoId) cancelAnimationFrame(animacaoId);

  const velocidadeDescida = 2;   // Velocidade ao descer (igual à subida)
  const velocidadeSubida = 2;    // Retorno ao topo

  // Sincroniza com a posição real da página (ex.: após interação manual)
  posicaoScroll = window.scrollY;

  function passo() {
    if (pausadoPorInteracao) return;

    // Parado por regra (ver autoScrollPermitido): fica de prontidão
    if (!autoScrollPermitido()) {
      precisaSincronizarScroll = true;
      animacaoId = requestAnimationFrame(passo);
      return;
    }

    // Ao voltar a rolar, continua de onde a tela está, sem dar salto
    if (precisaSincronizarScroll) {
      posicaoScroll = window.scrollY;
      precisaSincronizarScroll = false;
    }

    // Se estiver em pausa (no topo ou no fundo), decrementa o contador
    if (tempoPausaScroll > 0) {
      tempoPausaScroll--;
      animacaoId = requestAnimationFrame(passo);
      return;
    }

    const maxScroll = obterScrollMaximo();

    // Página sem conteúdo suficiente para rolar: apenas aguarda
    if (maxScroll <= 0) {
      animacaoId = requestAnimationFrame(passo);
      return;
    }

    if (direcaoScroll === 1) {
      // Descendo
      posicaoScroll += velocidadeDescida;

      if (posicaoScroll >= maxScroll - 1) {
        posicaoScroll = maxScroll;
        window.scrollTo(0, posicaoScroll);
        direcaoScroll = -1;      // Chegou ao fim: passa a subir
        tempoPausaScroll = 240;  // Pausa de ~4 segundos no fundo
      } else {
        window.scrollTo(0, posicaoScroll);
      }
    } else {
      // Subindo
      posicaoScroll -= velocidadeSubida;

      if (posicaoScroll <= 0) {
        posicaoScroll = 0;
        window.scrollTo(0, 0);
        direcaoScroll = 1;       // Chegou ao topo: passa a descer
        tempoPausaScroll = 240;  // Pausa de ~4 segundos no topo
      } else {
        window.scrollTo(0, posicaoScroll);
      }
    }

    animacaoId = requestAnimationFrame(passo);
  }

  animacaoId = requestAnimationFrame(passo);
}

// Pausa temporariamente o auto-scroll se houver interação manual
window.addEventListener("wheel", () => {
  pausadoPorInteracao = true;
  if (animacaoId) cancelAnimationFrame(animacaoId);
  if (timeoutRetomada) clearTimeout(timeoutRetomada);

  timeoutRetomada = setTimeout(() => {
    pausadoPorInteracao = false;
    iniciarAutoScrollSuave();
  }, 20000);
});

window.addEventListener("touchstart", () => {
  pausadoPorInteracao = true;
  if (animacaoId) cancelAnimationFrame(animacaoId);
  if (timeoutRetomada) clearTimeout(timeoutRetomada);

  timeoutRetomada = setTimeout(() => {
    pausadoPorInteracao = false;
    iniciarAutoScrollSuave();
  }, 20000);
});