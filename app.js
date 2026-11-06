const input = document.getElementById("arquivoExcel");
const btnUploadTrigger = document.getElementById("btnUploadTrigger");
const btnLimpar = document.getElementById("btnLimpar");
const painel = document.getElementById("painel");

// Elementos de KPI
const kpiDocas = document.getElementById("kpi-docas");
const kpiPedidos = document.getElementById("kpi-pedidos");
const kpiCubagem = document.getElementById("kpi-cubagem");

btnUploadTrigger.addEventListener("click", () => {
  const senhaDigitada = prompt("Digite a senha de administração para carregar a planilha:");
  if (senhaDigitada === null) return;

  if (senhaDigitada === "9704") {
    input.click();
  } else {
    alert("Senha incorreta! Acesso negado.");
  }
});

input.addEventListener("change", lerArquivo);

btnLimpar.addEventListener("click", () => {
  const senhaDigitada = prompt("Digite a senha de administração para limpar os dados:");
  if (senhaDigitada === null) return;

  if (senhaDigitada === "9704") {
    localStorage.removeItem("darnel_dados_docas");
    alert("Dados limpos com sucesso!");
    location.reload();
  } else {
    alert("Senha incorreta! Ação negada.");
  }
});

window.addEventListener("DOMContentLoaded", () => {
  const dadosSalvos = localStorage.getItem("darnel_dados_docas");
  if (dadosSalvos) {
    try {
      const dados = JSON.parse(dadosSalvos);
      gerarPainel(dados);
    } catch (e) {
      console.error("Erro ao carregar dados salvos:", e);
      localStorage.removeItem("darnel_dados_docas");
    }
  }
});

function lerArquivo(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  const reader = new FileReader();

  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });

    const aba = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(aba);

    localStorage.setItem("darnel_dados_docas", JSON.stringify(dados));

    gerarPainel(dados);
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
        cubagem: 0,
        pedidos: 0,
        ocupada: true
      };
    }

    if (clienteLimpo) {
      docasOcupadasMap[doca].clientes.add(clienteLimpo);
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

    card.innerHTML = `
      <div class="card-stripe" style="background-color: ${corStatus}"></div>
      <div class="card-header">
        <div class="doca-titulo-container">
          <span class="status-dot" style="background-color: ${corStatus}; box-shadow: 0 0 10px ${corStatus}"></span>
          <h2>Doca ${doca}</h2>
        </div>
        ${
          info.ocupada 
            ? `<span class="badge-pedidos">${info.pedidos} ${info.pedidos === 1 ? 'pedido' : 'pedidos'}</span>`
            : `<span class="badge-livre">LIVRE</span>`
        }
      </div>

      <div class="card-body">
        <div class="subtitulo-clientes">${info.ocupada ? `Clientes (${listaClientes.length})` : 'Status'}</div>
        <div class="lista-clientes">
          ${
            info.ocupada
              ? (listaClientes.length > 0
                  ? listaClientes.map((c) => `<div class="cliente">${c}</div>`).join("")
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

  // Inicia o auto-scroll após a renderização
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

  const velocidadeDescida = 2; // Velocidade suave ao descer
  const velocidadeSubida = 2;    // Retorno ao topo, suave porém mais rápido

  // Sincroniza com a posição real da página (ex.: após interação manual)
  posicaoScroll = window.scrollY;

  function passo() {
    if (pausadoPorInteracao) return;

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