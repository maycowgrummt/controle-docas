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


const app = initializeApp(firebaseConfig);
// Cache local: se o Wi-Fi cair, os cliques ficam guardados e sincronizam depois.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

let offsetMs = 0; // diferença entre o relógio do aparelho e o do servidor
let diaAtual = null;
let cancelarAssinatura = null;
const registros = {}; // id do documento -> dados
let totalCarregando = 0; // quantos clientes estão carregando agora (usado pelo auto-scroll)

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

function controlesDe(estado) {
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

function setTexto(el, txt) {
  if (el && el.textContent !== txt) el.textContent = txt;
}

function pintarLinha(row, t) {
  const chave = chaveDe(diaAtual, row.dataset.doca, row.dataset.cliente);
  row.dataset.chave = chave;
  const c = calcular(registros[chave]?.eventos, t);

  // Só reconstrói os botões quando algo mudou (preserva o foco e a lista de motivos)
  const assinatura = `${c.estado}|${c.motivoAtual || ""}|${c.fim || ""}`;
  if (row.dataset.assinatura !== assinatura) {
    row.dataset.assinatura = assinatura;
    row.dataset.estado = c.estado;
    row.classList.remove("cli-pendente", "cli-carregando", "cli-pausado", "cli-concluido");
    row.classList.add(`cli-${c.estado}`);
    const ctrl = row.querySelector(".cli-ctrl");
    if (ctrl) ctrl.innerHTML = controlesDe(c.estado);
    row.querySelector(".cli-motivos")?.remove();
    setTexto(row.querySelector(".cli-info"), infoDe(c));
  }

  const tempo = c.estado === "pendente" ? "" : (c.estado === "concluido" ? "✔ " : c.estado === "pausado" ? "⏸ " : "") + fmtDuracao(c.liquidoMs);
  setTexto(row.querySelector(".cli-tempo"), tempo);
  return c.estado;
}

function aplicar() {
  if (!diaAtual) return;
  const t = agora();
  const cont = { carregando: 0, pausado: 0, concluido: 0, total: 0 };

  document.querySelectorAll("#painel .card").forEach((card) => {
    const linhas = card.querySelectorAll(".cliente[data-doca]");
    if (!linhas.length) return;
    let concluidas = 0;
    let iniciadas = 0;
    linhas.forEach((row) => {
      const est = pintarLinha(row, t);
      if (est !== "pendente") iniciadas++;
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
      prog.classList.toggle("completo", todas);
      prog.querySelector(".barra i").style.width = `${(concluidas / linhas.length) * 100}%`;
      setTexto(prog.querySelector(".txt"), todas ? `✔ CONCLUÍDA (${concluidas} de ${linhas.length})` : `${concluidas} de ${linhas.length} concluídos`);
    }
  });

  totalCarregando = cont.carregando;
  setTexto(document.getElementById("kpi-carregando"), String(cont.carregando));
  setTexto(document.getElementById("kpi-pausadas"), String(cont.pausado));
  setTexto(document.getElementById("kpi-concluidas"), `${cont.concluido} / ${cont.total}`);
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

function abrirJanela({ titulo, detalhe, rotulo, tipo, inputmode, classeCampo = "", sugestoes = [], validar }) {
  if (janelaAberta) return Promise.resolve(null);
  janelaAberta = true;

  return new Promise((resolve) => {
    const fundo = document.createElement("div");
    fundo.className = "senha-fundo";
    fundo.innerHTML = `
      <form class="senha-janela" role="dialog" aria-modal="true" aria-labelledby="senhaTitulo">
        <h2 id="senhaTitulo" class="senha-titulo"></h2>
        <p class="senha-detalhe"></p>
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

    const campo = fundo.querySelector(".senha-campo");
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
      if (!problema) {
        fechar(texto);
      } else {
        erro.textContent = problema;
        campo.value = "";
        campo.focus();
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
async function pedirNome(acao, row) {
  const sugestoes = nomesSugeridos();
  const nome = await abrirJanela({
    titulo: ROTULOS[acao],
    detalhe: `${row.dataset.cliente} · Doca ${row.dataset.doca}`,
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
    if (nome) registrar(row, EVENTO_COM_NOME[acao], {}, nome);
    return;
  }

  switch (acao) {
    case "retomar":   registrar(row, "retomada"); break;
    case "pausar":    abrirMotivos(row); break;
    case "motivo":    registrar(row, "pausa", { motivo: botao.dataset.motivo }); break;
    case "cancelar-motivo": row.querySelector(".cli-motivos")?.remove(); break;
  }
});

// ---------- Interface auxiliar ----------
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast-cron";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
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