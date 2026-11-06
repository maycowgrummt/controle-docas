const input = document.getElementById("arquivoExcel");
const btnUploadTrigger = document.getElementById("btnUploadTrigger");
const btnLimpar = document.getElementById("btnLimpar");
const painel = document.getElementById("painel");

// Elementos de KPI
const kpiDocas = document.getElementById("kpi-docas");
const kpiPedidos = document.getElementById("kpi-pedidos");
const kpiCubagem = document.getElementById("kpi-cubagem");

// Intercepta o clique no botão de carregar planilha para pedir a senha (9704)
btnUploadTrigger.addEventListener("click", () => {
  const senhaDigitada = prompt("Digite a senha de administração para carregar a planilha:");
  
  if (senhaDigitada === null) return; // Cancelou

  if (senhaDigitada === "9704") {
    // Senha correta: dispara o clique no input de arquivo oculto
    input.click();
  } else {
    alert("Senha incorreta! Acesso negado.");
  }
});

input.addEventListener("change", lerArquivo);

// Ação do botão de limpar protegida por senha (9704)
btnLimpar.addEventListener("click", () => {
  const senhaDigitada = prompt("Digite a senha de administração para limpar os dados:");
  
  if (senhaDigitada === null) return; // Cancelou

  if (senhaDigitada === "9704") {
    localStorage.removeItem("darnel_dados_docas");
    alert("Dados limpos com sucesso!");
    location.reload();
  } else {
    alert("Senha incorreta! Ação negada.");
  }
});

// Ao carregar a página, verifica se já existe uma planilha salva no navegador
window.addEventListener("DOMContentLoaded", () => {
  const dadosSalvos = localStorage.getItem("darnel_dados_docas");
  if (dadosSalvos) {
    try {
      const dados = JSON.parse(dadosSalvos);
      gerarPainel(dados);
      iniciarAutoScrollSuave();
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

    // Salva os dados brutos no LocalStorage do navegador
    localStorage.setItem("darnel_dados_docas", JSON.stringify(dados));

    gerarPainel(dados);
    iniciarAutoScrollSuave();
  };

  reader.readAsArrayBuffer(arquivo);
}

function gerarPainel(dados) {
  painel.innerHTML = "";

  const docas = {};
  let totalPedidosGeral = 0;
  let totalCubagemGeral = 0;

  dados.forEach((linha) => {
    const doca = linha["Local Stage"] ? String(linha["Local Stage"]).trim() : "Sem Doca";

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

    if (!docas[doca]) {
      docas[doca] = {
        clientes: new Set(),
        cubagem: 0,
        pedidos: 0,
      };
    }

    if (clienteLimpo) {
      docas[doca].clientes.add(clienteLimpo);
    }

    docas[doca].pedidos++;
    docas[doca].cubagem += cubagem;

    totalPedidosGeral++;
    totalCubagemGeral += cubagem;
  });

  // Atualizar Indicadores Globais (KPIs)
  kpiDocas.textContent = Object.keys(docas).length;
  kpiPedidos.textContent = totalPedidosGeral;
  kpiCubagem.textContent = `${totalCubagemGeral.toFixed(2)} m³`;

  // Ordenar por maior cubagem
  const docasOrdenadas = Object.entries(docas).sort(
    (a, b) => b[1].cubagem - a[1].cubagem
  );

  docasOrdenadas.forEach(([doca, info]) => {
    const card = document.createElement("div");

    let classeStatus = "status-card-ok";
    let corStatus = "var(--status-ok)";

    if (info.cubagem > 80) {
      classeStatus = "status-card-critical";
      corStatus = "var(--status-critical)";
    } else if (info.cubagem > 30) {
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
          <h2>${doca}</h2>
        </div>
        <span class="badge-pedidos">${info.pedidos} ${info.pedidos === 1 ? 'pedido' : 'pedidos'}</span>
      </div>

      <div class="card-body">
        <div class="subtitulo-clientes">Clientes (${listaClientes.length})</div>
        <div class="lista-clientes">
          ${
            listaClientes.length > 0
              ? listaClientes.map((c) => `<div class="cliente">${c}</div>`).join("")
              : `<div class="cliente">Sem cliente especificado</div>`
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
}

function limparCliente(texto) {
  return texto
    .replace(/\d{2}\/\d{2}\/\d{2,4}/g, "")
    .replace(/\b(FOB|CASC)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Sistema de Auto-Scroll Suave e Contínuo ---
let animacaoId = null;
let pausadoPorInteracao = false;
let timeoutRetomada = null;

function iniciarAutoScrollSuave() {
  if (animacaoId) cancelAnimationFrame(animacaoId);

  let direcao = 1; 
  const velocidade = 0.4; 
  let tempoPausa = 0;

  function passo() {
    if (pausadoPorInteracao) return;

    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;

    if (maxScroll <= 10) return;

    if (tempoPausa > 0) {
      tempoPausa--;
      animacaoId = requestAnimationFrame(passo);
      return;
    }

    window.scrollBy(0, velocidade * direcao);

    if (window.scrollY >= maxScroll - 2) {
      direcao = -1; 
      tempoPausa = 180; 
    } 
    else if (window.scrollY <= 0) {
      direcao = 1; 
      tempoPausa = 180; 
    }

    animacaoId = requestAnimationFrame(passo);
  }

  setTimeout(() => {
    animacaoId = requestAnimationFrame(passo);
  }, 3000);
}

window.addEventListener("wheel", () => {
  pausadoPorInteracao = true;
  if (animacaoId) cancelAnimationFrame(animacaoId);
  if (timeoutRetomada) clearTimeout(timeoutRetomada);

  timeoutRetomada = setTimeout(() => {
    pausadoPorInteracao = false;
    iniciarAutoScrollSuave();
  }, 15000);
});