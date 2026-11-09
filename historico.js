// ============================================================
// Aba Histórico  |  Painel de Docas
// Mostra só os clientes FINALIZADOS do período escolhido e gera
// o Excel com duas abas: "Detalhado" e "Resumo".
// Os tempos vêm sempre da função calcular (cronometro.js).
// ============================================================
import { collection, deleteDoc, doc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { db, COLECAO, calcular, diaOperacional, fmtDuracao, fmtHora, esc, toast, pedirSenha } from "./cronometro.js";

const MS_POR_DIA = 86400000;

const el = (id) => document.getElementById(id);
const filtros = {
  de: el("histDe"),
  ate: el("histAte"),
  doca: el("histDoca"),
  cliente: el("histCliente"),
  operador: el("histOperador")
};
const corpoTabela = el("histCorpo");
const tabela = el("histTabela");
const mensagem = el("histMensagem");
const contagem = el("histContagem");
const btnExportar = el("btnExportar");

let cancelarAssinatura = null;
let todas = [];     // clientes finalizados do período
let visiveis = [];  // os que passam nos filtros (é o que vai para o Excel)
let datasEscolhidas = false; // enquanto ninguém mexer nas datas, a aba abre sempre no dia atual

// ---------- Monta os dados de cada cliente ----------
function linhaDe(d, id) {
  const c = calcular(d.eventos, Date.now());
  if (c.estado !== "concluido") return null;

  const eventos = d.eventos || [];
  const motivos = {};
  c.pausas.forEach((p) => { motivos[p.motivo] = (motivos[p.motivo] || 0) + p.ms; });

  return {
    id,
    dia: d.dia,
    doca: String(d.doca),
    cliente: d.cliente,
    pedidos: d.pedidos || 0,
    volumeM3: d.volumeM3 || 0,
    inicio: c.inicio,
    fim: c.fim,
    liquidoMs: c.liquidoMs,
    pausadoMs: c.pausadoMs,
    brutoMs: c.brutoMs,
    motivos: Object.entries(motivos).map(([m, ms]) => `${m} (${fmtDuracao(ms)})`).join(", "),
    iniciadoPor: eventos.find((e) => e.tipo === "inicio" && e.t === c.inicio)?.op || "",
    finalizadoPor: eventos.find((e) => e.tipo === "fim" && e.t === c.fim)?.op || ""
  };
}

const ordenarDoca = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const semAcento = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const diaBr = (dia) => dia.split("-").reverse().join("/");

// ---------- Tela ----------
function preencherOpcoes(select, rotulo, valores) {
  const atual = select.value;
  select.innerHTML = `<option value="">${rotulo}</option>` +
    valores.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  select.value = valores.includes(atual) ? atual : "";
}

function mostrarMensagem(texto) {
  mensagem.textContent = texto;
  mensagem.hidden = !texto;
  tabela.hidden = !!texto;
}

function desenhar() {
  preencherOpcoes(filtros.doca, "Todas", [...new Set(todas.map((l) => l.doca))].sort(ordenarDoca));
  preencherOpcoes(
    filtros.operador,
    "Todos",
    [...new Set(todas.flatMap((l) => [l.iniciadoPor, l.finalizadoPor]).filter(Boolean))].sort()
  );

  const doca = filtros.doca.value;
  const operador = filtros.operador.value;
  const cliente = semAcento(filtros.cliente.value.trim());

  visiveis = todas.filter((l) =>
    (!doca || l.doca === doca) &&
    (!operador || l.iniciadoPor === operador || l.finalizadoPor === operador) &&
    (!cliente || semAcento(l.cliente).includes(cliente))
  );

  corpoTabela.innerHTML = visiveis.map((l) => `
    <tr>
      <td>${diaBr(l.dia)}</td>
      <td>${esc(l.doca)}</td>
      <td class="hist-cliente">${esc(l.cliente)}</td>
      <td class="num">${l.pedidos}</td>
      <td class="num">${l.volumeM3.toFixed(2)}</td>
      <td>${fmtHora(l.inicio)}</td>
      <td>${fmtHora(l.fim)}</td>
      <td class="num">${fmtDuracao(l.liquidoMs)}</td>
      <td class="num">${fmtDuracao(l.pausadoMs)}</td>
      <td class="num">${fmtDuracao(l.brutoMs)}</td>
      <td>${esc(l.motivos) || "—"}</td>
      <td>${esc(l.iniciadoPor) || "—"}</td>
      <td>${esc(l.finalizadoPor) || "—"}</td>
      <td><button type="button" class="btn-excluir" data-id="${esc(l.id)}">🗑 Excluir</button></td>
    </tr>`).join("");

  const volume = visiveis.reduce((soma, l) => soma + l.volumeM3, 0);
  contagem.textContent = `${visiveis.length} ${visiveis.length === 1 ? "cliente finalizado" : "clientes finalizados"} · ${volume.toFixed(2)} m³`;
  btnExportar.disabled = visiveis.length === 0;
  mostrarMensagem(visiveis.length ? "" : "Nenhum cliente finalizado com esses filtros.");
}

// ---------- Leitura em tempo real ----------
function desligar() {
  if (cancelarAssinatura) cancelarAssinatura();
  cancelarAssinatura = null;
}

function assinar() {
  desligar();
  todas = [];
  btnExportar.disabled = true;
  contagem.textContent = "";

  const de = filtros.de.value;
  const ate = filtros.ate.value;
  if (de > ate) {
    desenhar();
    mostrarMensagem("A data inicial está depois da data final.");
    return;
  }

  mostrarMensagem("Carregando...");
  cancelarAssinatura = onSnapshot(
    query(collection(db, COLECAO), where("dia", ">=", de), where("dia", "<=", ate)),
    (snap) => {
      todas = snap.docs.map((d) => linhaDe(d.data(), d.id)).filter(Boolean).sort((a, b) => b.fim - a.fim);
      desenhar();
    },
    (err) => {
      console.error("Erro ao ler o histórico:", err);
      mostrarMensagem("Não foi possível carregar o histórico. Verifique a conexão.");
      toast("Sem conexão com o banco dos cronômetros.");
    }
  );
}

function mudarData(campo) {
  if (!campo.value) campo.value = diaOperacional();
  datasEscolhidas = true;
  assinar();
}

filtros.de.addEventListener("change", () => mudarData(filtros.de));
filtros.ate.addEventListener("change", () => mudarData(filtros.ate));
filtros.doca.addEventListener("change", desenhar);
filtros.operador.addEventListener("change", desenhar);
filtros.cliente.addEventListener("input", desenhar);

// Só lê o banco enquanto a aba está aberta
new MutationObserver(() => {
  if (el("aba-historico").hidden) {
    desligar();
    return;
  }
  if (!datasEscolhidas) filtros.de.value = filtros.ate.value = diaOperacional();
  assinar();
}).observe(el("aba-historico"), { attributes: true, attributeFilter: ["hidden"] });

// ---------- Excluir registro ----------
corpoTabela.addEventListener("click", async (ev) => {
  const botao = ev.target.closest(".btn-excluir");
  if (!botao) return;
  const linha = visiveis.find((l) => l.id === botao.dataset.id);
  if (!linha) return;

  const liberado = await pedirSenha(
    "🗑 Excluir registro",
    `${linha.cliente} · Doca ${linha.doca} · ${diaBr(linha.dia)}. Esta exclusão não pode ser desfeita.`
  );
  if (!liberado) return;

  try {
    await deleteDoc(doc(db, COLECAO, linha.id));
  } catch (e) {
    console.error("Erro ao excluir registro:", e);
    toast("Não foi possível excluir. Verifique a conexão e tente de novo.");
  }
});

// ---------- Excel ----------
const celDuracao = (ms) => ({ t: "n", v: ms / MS_POR_DIA, z: "[h]:mm:ss" });
const celVolume = (v) => ({ t: "n", v, z: "0.00" });

function celData(dia) {
  const [a, m, d] = dia.split("-").map(Number);
  return { t: "n", v: Date.UTC(a, m - 1, d) / MS_POR_DIA + 25569, z: "dd/mm/yyyy" };
}

function resumoPorDoca(linhas) {
  const docas = {};
  linhas.forEach((l) => {
    const r = (docas[l.doca] ??= { clientes: 0, volumeM3: 0, liquidoMs: 0, pausadoMs: 0 });
    r.clientes++;
    r.volumeM3 += l.volumeM3;
    r.liquidoMs += l.liquidoMs;
    r.pausadoMs += l.pausadoMs;
  });
  return docas;
}

function linhaResumo(rotulo, r) {
  return [rotulo, r.clientes, celVolume(r.volumeM3), celDuracao(r.liquidoMs / r.clientes), celDuracao(r.pausadoMs)];
}

function montarPlanilha(linhas) {
  const detalhado = XLSX.utils.aoa_to_sheet([
    ["Dia", "Doca", "Cliente", "Pedidos", "Volume (m³)", "Início", "Fim", "Tempo carregando", "Tempo em pausa", "Tempo total", "Motivos das pausas", "Iniciado por", "Finalizado por"],
    ...linhas.map((l) => [
      celData(l.dia), l.doca, l.cliente, l.pedidos, celVolume(l.volumeM3),
      fmtHora(l.inicio), fmtHora(l.fim),
      celDuracao(l.liquidoMs), celDuracao(l.pausadoMs), celDuracao(l.brutoMs),
      l.motivos, l.iniciadoPor, l.finalizadoPor
    ])
  ]);
  detalhado["!cols"] = [12, 7, 28, 9, 12, 8, 8, 17, 15, 12, 36, 18, 18].map((wch) => ({ wch }));
  detalhado["!autofilter"] = { ref: detalhado["!ref"] };

  const docas = resumoPorDoca(linhas);
  const total = Object.values(resumoPorDoca(linhas.map((l) => ({ ...l, doca: "total" })))).at(0);
  const resumo = XLSX.utils.aoa_to_sheet([
    ["Doca", "Clientes atendidos", "Volume (m³)", "Tempo médio carregando", "Tempo total em pausa"],
    ...Object.keys(docas).sort(ordenarDoca).map((d) => linhaResumo(d, docas[d])),
    ...(total ? [linhaResumo("TOTAL", total)] : [])
  ]);
  resumo["!cols"] = [10, 18, 12, 24, 22].map((wch) => ({ wch }));

  const arquivo = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(arquivo, detalhado, "Detalhado");
  XLSX.utils.book_append_sheet(arquivo, resumo, "Resumo");
  return arquivo;
}

btnExportar.addEventListener("click", () => {
  if (!window.XLSX) {
    toast("A ferramenta de Excel não carregou. Verifique a internet e atualize a página.");
    return;
  }
  const de = filtros.de.value;
  const ate = filtros.ate.value;
  XLSX.writeFile(montarPlanilha(visiveis), `historico-docas_${de === ate ? de : `${de}_a_${ate}`}.xlsx`);
});

export { linhaDe, montarPlanilha };
