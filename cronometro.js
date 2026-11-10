// ============================================================
// Cronômetro de carregamento por cliente  |  Painel de Docas
// Persistência: Firebase Firestore (coleção "cronometros")
//
// Como funciona: cada clique grava um EVENTO (inicio, pausa,
// retomada, fim, reabrir) com horário. O estado e os tempos são
// sempre CALCULADOS a partir dos eventos. Por isso o cronômetro
// sobrevive a recarregar a página e funciona em vários aparelhos.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  query,
  where,
  arrayUnion,
  deleteField,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdYp2Mhc9WrlrtgvVNs5kDZXMw0HT4JQE",
  authDomain: "controle-docas-75ae8.firebaseapp.com",
  projectId: "controle-docas-75ae8",
  storageBucket: "controle-docas-75ae8.firebasestorage.app",
  messagingSenderId: "746323970385",
  appId: "1:746323970385:web:875676c23b19508bf42b70"
};

// --- Configurações fáceis de ajustar ---
const COLECAO = "cronometros";
const HORA_VIRADA_DIA = 4; // antes das 04:00 ainda conta como o dia anterior (turno da noite)
const MOTIVOS_PAUSA = ["Empilhadeira", "Conferência", "Motorista", "Outro"];
const CHAVE_OPERADORES = "darnel_operadores"; // nomes já usados neste aparelho (viram sugestões)
const MAX_SUGESTOES = 20;
const DOC_STATUS_DOCAS = "_docas"; // documento com as docas em manutenção, bloqueadas ou com restrição
const TIPOS_STATUS_DOCA = { manutencao: "Manutenção", bloqueada: "Bloqueada", restricao: "Com restrição" };
const TIPO_OPERANDO = "restricao"; // este status mostra o aviso, mas a doca continua operando


const app = initializeApp(firebaseConfig);
// Cache local: se o Wi-Fi cair, os cliques ficam guardados e sincronizam depois.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

let offsetMs = 0; // diferença entre o relógio do aparelho e o do servidor
let diaAtual = null;
let cancelarAssinatura = null;
const registros = {}; // id do documento -> dados
let statusDocas = {}; // doca -> { tipo, motivo, nome, t } das docas com algum status
let totalCarregando = 0; // quantos clientes estão carregando agora (usado pelo auto-scroll)
let leituraDoServidor = false; // já chegou a primeira leitura real do banco (não só a cópia do aparelho)
let docasConcluidasAntes = null; // docas já concluídas na pintura anterior (para o brilho de "acabou")

// ---------- Utilidades ----------
const agora = () => Date.now() + offsetMs;

function diaOperacional() {
  const d = new Date(agora() - HORA_VIRADA_DIA * 3600 * 1000);
  return d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
}

function slug(txt) {
  return String(txt)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const chaveDe = (dia, doca, cliente) => `${dia}__${doca}__${slug(cliente)}`;

function fmtDuracao(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function fmtHora(ms) {
  return new Date(ms).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo"
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Cálculo dos tempos a partir dos eventos ----------
function calcular(eventos, tAgora) {
  const evs = [...(eventos || [])].sort((a, b) => a.t - b.t);
  const r = {
    estado: "pendente",
    inicio: null,
    fim: null,
    liquidoMs: 0,
    pausadoMs: 0,
    brutoMs: 0,
    pausas: [],
    motivoAtual: null
  };
  let seg = null; // início do trecho "carregando" em andamento
  let pausaDesde = null;
  let motivo = null;

  const fecharPausa = (t) => {
    const dur = Math.max(0, t - pausaDesde);
    r.pausadoMs += dur;
    r.pausas.push({ motivo, ms: dur });
    pausaDesde = null;
  };

  for (const e of evs) {
    if (e.tipo === "inicio" && r.estado === "pendente") {
      r.estado = "carregando";
      r.inicio = e.t;
      seg = e.t;
    } else if (e.tipo === "pausa" && r.estado === "carregando") {
      r.liquidoMs += Math.max(0, e.t - seg);
      r.estado = "pausado";
      pausaDesde = e.t;
      motivo = e.motivo || "Outro";
    } else if (e.tipo === "retomada" && r.estado === "pausado") {
      fecharPausa(e.t);
      r.estado = "carregando";
      seg = e.t;
    } else if (e.tipo === "fim" && (r.estado === "carregando" || r.estado === "pausado")) {
      if (r.estado === "carregando") r.liquidoMs += Math.max(0, e.t - seg);
      else fecharPausa(e.t);
      r.estado = "concluido";
      r.fim = e.t;
    } else if (e.tipo === "reabrir" && r.estado === "concluido") {
      r.estado = "carregando";
      r.fim = null;
      seg = e.t;
    }
  }

  if (r.estado === "carregando") {
    r.liquidoMs += Math.max(0, tAgora - seg);
  } else if (r.estado === "pausado") {
    r.pausadoMs += Math.max(0, tAgora - pausaDesde);
    r.motivoAtual = motivo;
  }
  if (r.inicio !== null) r.brutoMs = Math.max(0, (r.fim || tAgora) - r.inicio);
  return r;
}

// ---------- Pintura das linhas ----------
const ROTULOS = {
  iniciar: "▶ INICIAR",
  pausar: "⏸ PAUSAR",
  retomar: "▶ RETOMAR",
  finalizar: "■ FINALIZAR",
  reabrir: "↺ Reabrir"
};

function btn(acao, classe) {
  return `<button type="button" class="btn-cron ${classe}" data-acao="${acao}">${ROTULOS[acao]}</button>`;
}

function controlesDe(estado, indisponivel) {
  if (estado === "pendente" && indisponivel) {
    return `<button type="button" class="btn-cron btn-indisponivel" disabled>Doca indisponível</button>`;
  }
  if (estado === "pendente") return btn("iniciar", "btn-iniciar");
  if (estado === "carregando") return btn("pausar", "btn-pausar") + btn("finalizar", "btn-finalizar");
  if (estado === "pausado") return btn("retomar", "btn-iniciar") + btn("finalizar", "btn-finalizar");
  return btn("reabrir", "btn-reabrir");
}

function infoDe(c) {
  if (c.estado === "pausado") return `Pausado: ${esc(c.motivoAtual || "Outro")}`;
  if (c.estado === "carregando") return `Iniciou às ${fmtHora(c.inicio)}`;
  if (c.estado === "concluido") {
    const pausa = c.pausadoMs > 0 ? ` · Pausas ${fmtDuracao(c.pausadoMs)}` : "";
    return `${fmtHora(c.inicio)} às ${fmtHora(c.fim)}${pausa}`;
  }
  return "";
}

function docaIndisponivel(doca) {
  const status = statusDocas[doca];
  return !!status && status.tipo !== TIPO_OPERANDO;
}

function setTexto(el, txt) {
  if (el && el.textContent !== txt) el.textContent = txt;
}

function pintarLinha(row, t) {
  const chave = chaveDe(diaAtual, row.dataset.doca, row.dataset.cliente);
  row.dataset.chave = chave;
  const c = calcular(registros[chave]?.eventos, t);

  // Só reconstrói os botões quando algo mudou (preserva o foco e a lista de motivos)
  const indisponivel = docaIndisponivel(row.dataset.doca);
  const assinatura = `${c.estado}|${c.motivoAtual || ""}|${c.fim || ""}|${indisponivel}`;
  if (row.dataset.assinatura !== assinatura) {
    row.dataset.assinatura = assinatura;
    row.dataset.estado = c.estado;
    row.classList.remove("cli-pendente", "cli-carregando", "cli-pausado", "cli-concluido");
    row.classList.add(`cli-${c.estado}`);
    const ctrl = row.querySelector(".cli-ctrl");
    if (ctrl) ctrl.innerHTML = controlesDe(c.estado, indisponivel);
    row.querySelector(".cli-motivos")?.remove();
    setTexto(row.querySelector(".cli-info"), infoDe(c));
  }

  const tempo = c.estado === "pendente" ? "" : (c.estado === "concluido" ? "✔ " : c.estado === "pausado" ? "⏸ " : "") + fmtDuracao(c.liquidoMs);
  setTexto(row.querySelector(".cli-tempo"), tempo);
  return c.estado;
}

function pintarStatusDoca(card) {
  const status = statusDocas[card.dataset.doca];
  const assinatura = status ? `${status.tipo}|${status.motivo}|${status.nome}|${status.t}` : "";
  if (card.dataset.statusAssinatura === assinatura) return;
  card.dataset.statusAssinatura = assinatura;

  card.classList.toggle("doca-manutencao", status?.tipo === "manutencao");
  card.classList.toggle("doca-bloqueada", status?.tipo === "bloqueada");
  card.classList.toggle("doca-restricao", status?.tipo === "restricao");

  const faixa = card.querySelector(".doca-status");
  faixa.hidden = !status;
  const detalhe = status
    ? [status.motivo, `${status.nome} às ${fmtHora(status.t)}`].filter(Boolean).join(" · ")
    : "";
  setTexto(faixa.querySelector(".doca-status-tipo"), status ? TIPOS_STATUS_DOCA[status.tipo] : "");
  setTexto(faixa.querySelector(".doca-status-detalhe"), detalhe);
  card.title = status ? `${TIPOS_STATUS_DOCA[status.tipo]}: ${detalhe}` : "";

  const botao = card.querySelector("[data-doca-status]");
  botao.textContent = status ? "Liberar doca" : "Alterar status da doca";
  botao.classList.toggle("liberar", !!status);
}

// Número que conta até o valor novo (definido no app.js); sem ele, só troca o texto
const mostrarNumero = (el, texto) => (window.mostrarNumero ? window.mostrarNumero(el, texto) : setTexto(el, texto));

// TV: faixa das docas livres (montada pelo app.js). Pinta o status e conta só as que podem receber carga.
function pintarFaixaLivres() {
  const faixa = document.querySelector("#painel .livres-faixa");
  if (!faixa) return;
  let disponiveis = 0;
  faixa.querySelectorAll(".chip-doca").forEach((chip) => {
    const doca = chip.dataset.doca;
    const tipo = statusDocas[doca]?.tipo || "";
    Object.keys(TIPOS_STATUS_DOCA).forEach((t) => chip.classList.toggle(t, tipo === t));
    const titulo = `Doca ${doca}: ${tipo ? TIPOS_STATUS_DOCA[tipo] : "livre"}`;
    if (chip.title !== titulo) chip.title = titulo;
    if (!docaIndisponivel(doca)) disponiveis++;
  });
  setTexto(faixa.querySelector(".livres-total"), String(disponiveis));
}

function aplicar() {
  if (!diaAtual) return;
  const t = agora();
  const cont = { carregando: 0, pausado: 0, concluido: 0, total: 0, volumeTotal: 0, volumeConcluido: 0 };
  const concluidasAgora = new Set();

  document.querySelectorAll("#painel .card").forEach((card) => {
    pintarStatusDoca(card);
    const linhas = card.querySelectorAll(".cliente[data-doca]");
    if (!linhas.length) return;
    let concluidas = 0;
    let iniciadas = 0;
    linhas.forEach((row) => {
      const est = pintarLinha(row, t);
      if (est !== "pendente") iniciadas++;
      const volume = parseFloat(row.dataset.vol) || 0;
      cont.volumeTotal += volume;
      if (est === "concluido") cont.volumeConcluido += volume;
      cont.total++;
      if (est === "concluido") { concluidas++; cont.concluido++; }
      else if (est === "carregando") cont.carregando++;
      else if (est === "pausado") cont.pausado++;
    });

    card.classList.toggle("doca-iniciada", iniciadas > 0); // a barra de progresso depende disto na TV

    const prog = card.querySelector(".doca-progresso");
    if (prog) {
      const todas = concluidas === linhas.length;
      card.classList.toggle("doca-concluida", todas);
      if (todas) {
        concluidasAgora.add(card.dataset.doca);
        // Brilho só quando a doca acabou de terminar (não ao abrir a página nem ao recarregar a planilha)
        if (docasConcluidasAntes && !docasConcluidasAntes.has(card.dataset.doca)) {
          card.classList.add("acabou");
          setTimeout(() => card.classList.remove("acabou"), 1800);
        }
      }
      prog.classList.toggle("completo", todas);
      prog.querySelector(".barra i").style.width = `${(concluidas / linhas.length) * 100}%`;
      setTexto(prog.querySelector(".txt"), todas ? `✔ CONCLUÍDA (${concluidas} de ${linhas.length})` : `${concluidas} de ${linhas.length} ${linhas.length === 1 ? "concluído" : "concluídos"}`);
    }
  });

  if (leituraDoServidor) docasConcluidasAntes = concluidasAgora;

  totalCarregando = cont.carregando;
  mostrarNumero(document.getElementById("kpi-carregando"), String(cont.carregando));
  mostrarNumero(document.getElementById("kpi-pausadas"), String(cont.pausado));
  mostrarNumero(document.getElementById("kpi-concluidas"), `${cont.concluido} / ${cont.total}`);
  pintarFaixaLivres();

  document.getElementById("kpi-carregando").closest(".kpi-card").classList.toggle("kpi-carregando-ativo", cont.carregando > 0);
  document.getElementById("kpi-pausadas").closest(".kpi-card").classList.toggle("kpi-pausado-ativo", cont.pausado > 0);
  pintarProgressoDia(cont);
}

// Faixa do topo: a barra mede o volume dos clientes já finalizados
function pintarProgressoDia(cont) {
  const faixa = document.getElementById("progressoDia");
  faixa.hidden = cont.total === 0;
  if (!cont.total) return;

  const percentual = cont.volumeTotal > 0 ? Math.round((cont.volumeConcluido / cont.volumeTotal) * 100) : 0;
  const barra = faixa.querySelector(".progresso-barra");
  barra.setAttribute("aria-valuenow", String(percentual));
  barra.querySelector("i").style.width = `${percentual}%`;
  setTexto(faixa.querySelector(".progresso-percentual"), `${percentual}%`);
  setTexto(
    faixa.querySelector(".progresso-resumo"),
    `${cont.concluido} de ${cont.total} ${cont.total === 1 ? "cliente" : "clientes"} · ${window.formatarM3(cont.volumeConcluido)} de ${window.formatarM3(cont.volumeTotal)} m³ carregados`
  );
}

// ---------- Gravação ----------
// Pausar e Retomar não perguntam o nome: usam quem mexeu por último neste cronômetro
function ultimoOperador(row) {
  const eventos = [...(registros[row.dataset.chave]?.eventos || [])].sort((a, b) => a.t - b.t);
  return eventos.at(-1)?.op || "Não informado";
}

async function registrar(row, tipo, extra = {}, operador = ultimoOperador(row)) {
  const evento = { tipo, t: agora(), op: operador, ...extra };
  try {
    // arrayUnion + merge: dois aparelhos clicando ao mesmo tempo não apagam o evento um do outro.
    await setDoc(
      doc(db, COLECAO, row.dataset.chave),
      {
        dia: diaAtual,
        doca: row.dataset.doca,
        cliente: row.dataset.cliente,
        volumeM3: parseFloat(row.dataset.vol) || 0,
        pedidos: parseInt(row.dataset.ped, 10) || 0,
        atualizadoEm: serverTimestamp(),
        eventos: arrayUnion(evento)
      },
      { merge: true }
    );
  } catch (e) {
    console.error("Erro ao gravar cronômetro:", e);
    toast("Não foi possível gravar. Verifique a conexão e tente de novo.");
  }
}

function abrirMotivos(row) {
  if (row.querySelector(".cli-motivos")) { row.querySelector(".cli-motivos").remove(); return; }
  const div = document.createElement("div");
  div.className = "cli-motivos";
  div.innerHTML =
    `<div class="cli-motivos-titulo">Motivo da pausa</div>` +
    MOTIVOS_PAUSA.map((m) => `<button type="button" class="btn-motivo" data-acao="motivo" data-motivo="${esc(m)}">${esc(m)}</button>`).join("") +
    `<button type="button" class="btn-motivo cancelar" data-acao="cancelar-motivo">✕ Cancelar</button>`;
  row.appendChild(div);
}

// Janela com um campo só (senha ou nome). Responde o texto digitado, ou null se cancelar.
// validar devolve a mensagem de erro, ou "" quando o texto estiver certo.
let janelaAberta = false;

function abrirJanela({ titulo, detalhe, rotulo, tipo, inputmode, classeCampo = "", sugestoes = [], extraHtml = "", capturar, validar, validarExtra }) {
  if (janelaAberta) return Promise.resolve(null);
  janelaAberta = true;

  return new Promise((resolve) => {
    const fundo = document.createElement("div");
    fundo.className = "senha-fundo";
    fundo.innerHTML = `
      <form class="senha-janela" role="dialog" aria-modal="true" aria-labelledby="senhaTitulo">
        <h2 id="senhaTitulo" class="senha-titulo"></h2>
        <p class="senha-detalhe"></p>
        ${extraHtml}
        <label class="senha-rotulo" for="senhaCampo">${rotulo}</label>
        <input id="senhaCampo" class="senha-campo ${classeCampo}" type="${tipo}" inputmode="${inputmode}" maxlength="40" autocomplete="off" list="senhaSugestoes">
        <datalist id="senhaSugestoes">${sugestoes.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
        <p class="senha-erro" role="alert"></p>
        <div class="senha-botoes">
          <button type="button" class="btn-senha cancelar">Cancelar</button>
          <button type="submit" class="btn-senha confirmar">Confirmar</button>
        </div>
      </form>`;

    fundo.querySelector(".senha-titulo").textContent = titulo;
    fundo.querySelector(".senha-detalhe").textContent = detalhe;

    const campo = fundo.querySelector("#senhaCampo");
    const erro = fundo.querySelector(".senha-erro");

    const fechar = (resposta) => {
      fundo.remove();
      janelaAberta = false;
      resolve(resposta);
    };

    fundo.querySelector("form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const texto = campo.value.trim();
      const problema = validar(texto);
      // Conferência dos campos extras (ex.: motivo da doca); ela mesma põe o foco no campo certo
      const problemaExtra = problema ? "" : (validarExtra?.(fundo) || "");
      if (!problema && !problemaExtra) {
        capturar?.(fundo);
        fechar(texto);
      } else if (problema) {
        erro.textContent = problema;
        campo.value = "";
        campo.focus();
      } else {
        erro.textContent = problemaExtra;
      }
    });
    fundo.querySelector(".cancelar").addEventListener("click", () => fechar(null));
    fundo.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") fechar(null);
    });

    document.body.appendChild(fundo);
    campo.focus();
  });
}

// Senha de administração (usada pelo botão Modo operação, no app.js)
async function pedirSenha(titulo, detalhe) {
  const resposta = await abrirJanela({
    titulo,
    detalhe,
    rotulo: "Senha de administração",
    tipo: "password",
    inputmode: "numeric",
    validar: (texto) => (window.conferirSenhaAdmin(texto) ? "" : "Senha incorreta. Tente de novo.")
  });
  return resposta !== null;
}

function nomesSugeridos() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_OPERADORES)) || [];
  } catch (e) {
    return [];
  }
}

// Nome de quem está fazendo a ação. Responde null se cancelar.
const pedirNome = (acao, row) => perguntarNome({
  titulo: ROTULOS[acao],
  detalhe: `${row.dataset.cliente} · Doca ${row.dataset.doca}`
});

async function perguntarNome(opcoes) {
  const sugestoes = nomesSugeridos();
  const nome = await abrirJanela({
    ...opcoes,
    rotulo: "Seu nome",
    tipo: "text",
    inputmode: "text",
    classeCampo: "campo-nome",
    sugestoes,
    validar: (texto) => (/\p{L}/u.test(texto) ? "" : "Digite o nome da pessoa, com letras.")
  });
  if (nome) {
    const atualizados = [nome, ...sugestoes.filter((n) => n !== nome)].slice(0, MAX_SUGESTOES);
    try { localStorage.setItem(CHAVE_OPERADORES, JSON.stringify(atualizados)); } catch (e) { /* ok */ }
  }
  return nome;
}

// Ações que pedem o nome de quem clicou, e o evento que cada uma grava
const EVENTO_COM_NOME = { iniciar: "inicio", finalizar: "fim", reabrir: "reabrir" };

document.addEventListener("click", async (ev) => {
  // Os botões só reagem com o "Modo operação" ligado no cabeçalho (controlado pelo app.js)
  if (!document.body.classList.contains("modo-operacao")) return;
  const botao = ev.target.closest("[data-acao]");
  if (!botao) return;
  const row = botao.closest(".cliente[data-doca]");
  if (!row) return;

  const acao = botao.dataset.acao;

  if (EVENTO_COM_NOME[acao]) {
    const nome = await pedirNome(acao, row);
    if (!nome) return;
    // A doca pode ter ficado indisponível enquanto o nome era digitado
    if (acao === "iniciar" && docaIndisponivel(row.dataset.doca)) {
      toast("Esta doca ficou indisponível e o carregamento não foi iniciado.");
      return;
    }
    registrar(row, EVENTO_COM_NOME[acao], {}, nome);
    return;
  }

  switch (acao) {
    case "retomar":   registrar(row, "retomada"); break;
    case "pausar":    abrirMotivos(row); break;
    case "motivo":    registrar(row, "pausa", { motivo: botao.dataset.motivo }); break;
    case "cancelar-motivo": row.querySelector(".cli-motivos")?.remove(); break;
  }
});

// ---------- Docas em manutenção ou bloqueadas ----------
async function gravarStatusDoca(doca, valor) {
  try {
    await setDoc(doc(db, COLECAO, DOC_STATUS_DOCAS), { docas: { [doca]: valor } }, { merge: true });
  } catch (e) {
    console.error("Erro ao gravar a situação da doca:", e);
    toast("Não foi possível alterar a doca. Verifique a conexão e tente de novo.");
  }
}

async function indisponibilizarDoca(doca) {
  let extras = null;
  const nome = await perguntarNome({
    titulo: `Doca ${doca}`,
    detalhe: "Escolha a situação desta doca.",
    extraHtml: `
      <div class="doca-tipos" role="radiogroup" aria-label="Situação da doca">
        <label><input type="radio" name="docaTipo" value="manutencao" checked> Manutenção</label>
        <label><input type="radio" name="docaTipo" value="bloqueada"> Bloqueada</label>
        <label><input type="radio" name="docaTipo" value="restricao"> Com restrição (continua operando)</label>
      </div>
      <label class="senha-rotulo" for="docaMotivo">Motivo (obrigatório em Com restrição)</label>
      <input id="docaMotivo" class="senha-campo campo-nome doca-motivo" type="text" maxlength="60" autocomplete="off">`,
    validarExtra: (fundo) => {
      const tipo = fundo.querySelector('input[name="docaTipo"]:checked').value;
      const motivo = fundo.querySelector("#docaMotivo");
      if (tipo === TIPO_OPERANDO && !/\p{L}/u.test(motivo.value)) {
        motivo.focus();
        return "Em Com restrição, escreva o motivo (ex.: nivelador lento).";
      }
      return "";
    },
    capturar: (fundo) => {
      extras = {
        tipo: fundo.querySelector('input[name="docaTipo"]:checked').value,
        motivo: fundo.querySelector("#docaMotivo").value.trim()
      };
    }
  });
  if (nome) gravarStatusDoca(doca, { ...extras, nome, t: agora() });
}

async function liberarDoca(doca) {
  const status = statusDocas[doca];
  const nome = await perguntarNome({
    titulo: `Liberar Doca ${doca}`,
    detalhe: `Situação atual: ${TIPOS_STATUS_DOCA[status.tipo]}.`
  });
  if (nome) gravarStatusDoca(doca, deleteField());
}

document.addEventListener("click", (ev) => {
  if (!document.body.classList.contains("modo-operacao")) return;
  const botao = ev.target.closest("[data-doca-status]");
  if (!botao) return;
  const doca = botao.closest(".card").dataset.doca;
  if (statusDocas[doca]) liberarDoca(doca);
  else indisponibilizarDoca(doca);
});

function assinarStatusDocas() {
  onSnapshot(
    doc(db, COLECAO, DOC_STATUS_DOCAS),
    (snap) => {
      statusDocas = snap.data()?.docas || {};
      aplicar();
    },
    (err) => console.error("Erro ao ler a situação das docas:", err)
  );
}

// ---------- Interface auxiliar ----------
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast-cron";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("saindo"); // desliza para fora (cronometro.css)
    setTimeout(() => el.remove(), 300);
  }, 5000);
}

// ---------- Dados em tempo real ----------
function assinar() {
  if (cancelarAssinatura) cancelarAssinatura();
  Object.keys(registros).forEach((k) => delete registros[k]);
  diaAtual = diaOperacional();

  cancelarAssinatura = onSnapshot(
    query(collection(db, COLECAO), where("dia", "==", diaAtual)),
    (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === "removed") delete registros[ch.doc.id];
        else registros[ch.doc.id] = ch.doc.data();
      });
      if (!snap.metadata?.fromCache) leituraDoServidor = true;
      aplicar();
    },
    (err) => {
      console.error("Erro ao ler cronômetros:", err);
      toast("Sem conexão com o banco dos cronômetros.");
    }
  );
}

// Usa o horário do servidor, para um tablet com relógio errado não distorcer os tempos
async function sincronizarRelogio() {
  try {
    const ref = doc(db, COLECAO, "_relogio");
    const t0 = Date.now();
    await Promise.race([
      setDoc(ref, { t: serverTimestamp() }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
    ]);
    const snap = await getDoc(ref);
    const t1 = Date.now();
    const servidor = snap.data()?.t?.toMillis?.();
    if (servidor) {
      offsetMs = servidor - (t0 + t1) / 2;
      aplicar();
    }
  } catch (e) {
    console.warn("Relógio do servidor indisponível, usando o do aparelho.", e);
  }
}

// ---------- Início ----------
assinar();
assinarStatusDocas();
sincronizarRelogio();

setInterval(() => {
  if (diaOperacional() !== diaAtual) assinar(); // virou o dia operacional
  aplicar();
}, 1000);

// O app.js chama isto toda vez que redesenha os cards
window.Cronometro = { aplicar, carregando: () => totalCarregando, pedirSenha };

// Usado pela aba Histórico (historico.js)
export { db, COLECAO, calcular, diaOperacional, fmtDuracao, fmtHora, esc, toast, pedirSenha };
aplicar();