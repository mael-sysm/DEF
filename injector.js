// ==UserScript==
// @name         Inyector Maestro V37 (JSON)
// @namespace    http://tampermonkey.net/
// @version      37.1
// @description  Campos desde capitulo; calculadoras y diagramas desde JSON (1 o multiples variantes).
// @author       mercz d
// @match        https://cursosabiertos.usfx.bo/materias/*/capitulos/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (!document.querySelector('.ejercicio')) return;

    // =========================================================================
    // 0. CONFIGURACIÓN Y ESTADO
    // =========================================================================
    const CONFIG = {
        GITHUB_USER: 'mael-sysm',
        GITHUB_REPO: 'DEF',
        GITHUB_BRANCH: 'main',
        GITHUB_CARPETA: '', // ej. 'json' o '' si está en la raíz del repo DEF
        MAX_INTENTOS: 15,
        EXTRA_SEGUNDOS_DEFENSA: 60,
        ESPERA_HABILITAR_MS: 300,
        PAUSA_TRAS_CORREGIR_MS: 700
    };

    const SEL = {
        CAMPOS: '.campo_literal, .campo_arrastrar, .campo_dato',
        TODO: '.campo_literal, .campo_arrastrar, .campo_dato, p.opcionMultiple',
        SELECTORES: '.campo_arrastrar, .campo_dato',
        CORREGIR: '#btCorregir, .btCorregir'
    };

    const estado = {
        cancelado: false,
        cacheJSONGitHub: null,
        escudoActivo: false,
        menuAbierto: false,
        esperaDefensaSeg: 0,
        esperaDefensaActiva: false,
        timerEsperaDefensa: null
    };

    const timersHabilitar = new Map();

    // =========================================================================
    // 1. UTILIDADES GENERALES
    // =========================================================================
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const esVisible = el => !!(el && (el.offsetParent || el.getClientRects().length));
    const sinTildes = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    function formatearHMS(seg) {
        const s = Math.max(0, Math.floor(Number(seg) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        return [h, m, r].map(v => String(v).padStart(2, '0')).join(':');
    }

    async function esperarHasta(cond, max = 2000, paso = 40) {
        const fin = Date.now() + max;
        while (Date.now() < fin) {
            if (estado.cancelado) return false;
            try { if (cond()) return true; } catch (e) {}
            await sleep(paso);
        }
        return false;
    }

    function dispararEventos(el, tipos) {
        tipos.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    }

    function dispararShiftEnter(el, tipos = ['keydown', 'keyup']) {
        if (!el) return;
        tipos.forEach(tipo => el.dispatchEvent(new KeyboardEvent(tipo, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            shiftKey: true, bubbles: true, cancelable: true
        })));
    }

    function showToast(message, type = 'info') {
        if (estado.cancelado) return;
        const colors = { info: '#3b82f6', success: '#16a34a', error: '#ef4444', warning: '#f59e0b' };
        const toast = document.createElement('div');
        toast.className = 'tm-inyectado';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%) translateY(100px)',
            background: colors[type] || colors.info, color: 'white', padding: '12px 24px', borderRadius: '0px',
            fontFamily: 'system-ui, sans-serif', fontSize: '14px', fontWeight: '500',
            boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: '10000', opacity: '0',
            transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
        });
        document.body.appendChild(toast);
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(-50%) translateY(0)';
            toast.style.opacity = '1';
        });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // =========================================================================
    // 2. ESCUDO ANTI-ROBO DE FOCO Y SCROLL
    // =========================================================================
    const originales = {
        focus: HTMLElement.prototype.focus,
        scrollIntoView: Element.prototype.scrollIntoView,
        scrollTo: window.scrollTo
    };

    function activarEscudoFoco() {
        if (estado.escudoActivo) return;
        estado.escudoActivo = true;
        const posX = window.scrollX;
        const posY = window.scrollY;
        HTMLElement.prototype.focus = function () {};
        Element.prototype.scrollIntoView = function () {};
        window.scrollTo = function () { return originales.scrollTo.call(window, posX, posY); };
    }

    function desactivarEscudoFoco() {
        if (!estado.escudoActivo) return;
        estado.escudoActivo = false;
        HTMLElement.prototype.focus = originales.focus;
        Element.prototype.scrollIntoView = originales.scrollIntoView;
        window.scrollTo = originales.scrollTo;
    }

    // =========================================================================
    // 3. CUENTA REGRESIVA DE BLOQUEOS + 1 MIN AL GENERAR DEFENSA
    // =========================================================================
    function factorDispositivo() {
        return (typeof Capitulo !== 'undefined' && typeof Capitulo.esMovil === 'function' && Capitulo.esMovil())
            ? 1.5
            : 1;
    }

    function segundosBloqueoCorregir(ej) {
        const base = Number(ej && ej.tiempo) || 0;
        const tiempoDisp = Math.ceil(base * factorDispositivo());
        return Math.ceil(tiempoDisp * 0.25);
    }

    function calcularEsperaBloqueosMasExtra() {
        if (typeof capitulo === 'undefined' || !Array.isArray(capitulo.ejercicios)) {
            return CONFIG.EXTRA_SEGUNDOS_DEFENSA;
        }
        let suma = 0;
        capitulo.ejercicios.forEach((ej, idx) => {
            const div = document.getElementById(`ejercicio${idx + 1}`);
            const btn = div && div.querySelector('button');
            const asignado = (btn && !btn.disabled) || (Number(ej && ej.puntaje) > 0);
            if (asignado) suma += segundosBloqueoCorregir(ej);
        });
        return suma + CONFIG.EXTRA_SEGUNDOS_DEFENSA;
    }

    function actualizarContadorPanel() {
        if (!ui.contadorDefensa || !estado.esperaDefensaActiva) return;
        ui.contadorDefensa.style.display = 'block';
        ui.contadorDefensa.textContent = estado.esperaDefensaSeg > 0
            ? `Espera envío: ${formatearHMS(estado.esperaDefensaSeg)}`
            : `Listo envío: 00:00:00`;
    }

    function iniciarCuentaEsperaDefensa(segundos) {
        if (estado.timerEsperaDefensa) {
            clearInterval(estado.timerEsperaDefensa);
            estado.timerEsperaDefensa = null;
        }
        estado.esperaDefensaSeg = Math.max(0, Math.floor(Number(segundos) || 0));
        estado.esperaDefensaActiva = true;
        actualizarContadorPanel();

        estado.timerEsperaDefensa = setInterval(() => {
            if (estado.cancelado) {
                clearInterval(estado.timerEsperaDefensa);
                estado.timerEsperaDefensa = null;
                return;
            }
            if (estado.esperaDefensaSeg > 0) {
                estado.esperaDefensaSeg -= 1;
                actualizarContadorPanel();
            } else {
                clearInterval(estado.timerEsperaDefensa);
                estado.timerEsperaDefensa = null;
                actualizarContadorPanel();
            }
        }, 1000);
    }

    function interceptarGenerarDefensa(evento) {
        const btn = evento.target.closest && evento.target.closest('#btGenerarPrueba');
        if (!btn) return;
        setTimeout(() => {
            if (!estado.cancelado) {
                iniciarCuentaEsperaDefensa(calcularEsperaBloqueosMasExtra());
            }
        }, 400);
    }

    // =========================================================================
    // 4. LIMPIEZA AL GUARDAR / CERRAR
    // =========================================================================
    function limpiarRastro() {
        estado.cancelado = true;
        estado.esperaDefensaActiva = false;
        if (estado.timerEsperaDefensa) {
            clearInterval(estado.timerEsperaDefensa);
            estado.timerEsperaDefensa = null;
        }
        desactivarEscudoFoco();
        restaurarGenerarEjercicio();
        document.removeEventListener('click', alHacerClic, true);
        document.removeEventListener('click', interceptarGuardar, true);
        document.removeEventListener('click', interceptarGenerarDefensa, true);
        timersHabilitar.forEach(id => clearTimeout(id));
        timersHabilitar.clear();
        document.querySelectorAll('.tm-inyectado').forEach(el => el.remove());
    }

    function interceptarGuardar(evento) {
        const btn = evento.target.closest && evento.target.closest('#btGuardar, button[onclick*="savePage"]');
        if (btn) limpiarRastro();
    }

    function envolverSavePage() {
        if (typeof window.savePage !== 'function' || window.savePage._envuelto) return;
        const original = window.savePage;
        const reemplazo = function () {
            limpiarRastro();
            return original.apply(this, arguments);
        };
        reemplazo._envuelto = true;
        window.savePage = reemplazo;
    }

    // =========================================================================
    // 5. AUTO-DESBLOQUEO DEL BOTÓN CORREGIR
    // =========================================================================
    function habilitarCorregir(ej) {
        const corregir = ej.querySelector(SEL.CORREGIR);
        if (!corregir) return null;
        corregir.removeAttribute('disabled');
        corregir.disabled = false;
        return corregir;
    }

    function esBotonGenerarORepetir(boton) {
        const onclick = boton.getAttribute('onclick') || '';
        return boton.classList.contains('btGenerar') || onclick.includes('generar') ||
               boton.classList.contains('btRepetir') || onclick.includes('repetir');
    }

    function alHacerClic(evento) {
        const boton = evento.target.closest && evento.target.closest('button');
        if (!boton || !esBotonGenerarORepetir(boton)) return;

        const ejercicio = boton.closest('.ejercicio');
        if (!ejercicio) return;

        clearTimeout(timersHabilitar.get(ejercicio));
        const id = setTimeout(() => {
            timersHabilitar.delete(ejercicio);
            habilitarCorregir(ejercicio);
        }, CONFIG.ESPERA_HABILITAR_MS);
        timersHabilitar.set(ejercicio, id);
    }

    // =========================================================================
    // 6. DETECCIÓN DE CAPÍTULO Y CARGA DE JSON (GITHUB / LOCAL)
    // =========================================================================
    function obtenerMetadatosCapitulo() {
        const re = /materias\/([a-zA-Z0-9_-]+)\/capitulos\/capitulo(\d+)/i;
        const fuentes = [...document.querySelectorAll('script[src]')].map(s => s.src).concat(location.pathname);
        for (const f of fuentes) {
            const m = f.match(re);
            if (m) {
                return {
                    materia: m[1].toLowerCase(),
                    capitulo: `capitulo${parseInt(m[2], 10)}`,
                    num: String(parseInt(m[2], 10))
                };
            }
        }
        return null;
    }

    function extraerNumCapTitulo(titulo) {
        const m = sinTildes(titulo || '').match(/capitulo\s*(\d+)/i);
        return m ? String(parseInt(m[1], 10)) : null;
    }

    function construirRutasJSONGitHub(meta) {
        const { GITHUB_USER, GITHUB_REPO, GITHUB_BRANCH, GITHUB_CARPETA } = CONFIG;
        const carpeta = (GITHUB_CARPETA || '').replace(/^\/+|\/+$/g, '');
        const prefijo = carpeta
            ? `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${carpeta}`
            : `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

        const num = String(parseInt(meta.num, 10));
        const nombreBase = `${meta.materia}_${num}.json`;
        return [
            `${prefijo}/${nombreBase}`,
            `${prefijo}/${meta.materia}/${nombreBase}`
        ];
    }

    function normalizarJSON(raw, metaFallback = null) {
        if (!raw || typeof raw !== 'object' || !raw.ejercicios || typeof raw.ejercicios !== 'object') {
            throw new Error('JSON sin estructura "ejercicios".');
        }

        const materia = String(raw.materia || (metaFallback && metaFallback.materia) || '').toLowerCase() || null;
        const capituloNum = raw.capitulo !== undefined && raw.capitulo !== null && raw.capitulo !== ''
            ? String(parseInt(raw.capitulo, 10))
            : (metaFallback && metaFallback.num ? String(parseInt(metaFallback.num, 10)) : null);

        const ejercicios = {};
        for (const [id, info] of Object.entries(raw.ejercicios)) {
            if (!info || typeof info !== 'object') continue;
            const enunciados = {};

            if (info.enunciados && typeof info.enunciados === 'object') {
                for (const [kVar, calcs] of Object.entries(info.enunciados)) {
                    if (Array.isArray(calcs) && calcs.length > 0) {
                        enunciados[String(kVar)] = calcs;
                    }
                }
            } else if (Array.isArray(info.calculadoras) && info.calculadoras.length > 0) {
                const kVar = (info.enunciado !== undefined && info.enunciado !== null)
                    ? String(parseInt(info.enunciado, 10))
                    : 'default';
                enunciados[kVar] = info.calculadoras;
            }

            if (Object.keys(enunciados).length > 0) {
                const claves = Object.keys(enunciados).sort((a, b) => {
                    if (a === 'default') return 1;
                    if (b === 'default') return -1;
                    return Number(a) - Number(b);
                });
                ejercicios[id] = {
                    id,
                    variantes: claves,
                    enunciados
                };
            }
        }

        return { materia, capituloNum, ejercicios };
    }

    async function cargarJSONDesdeGitHub(meta) {
        if (estado.cacheJSONGitHub) return estado.cacheJSONGitHub;
        const urls = construirRutasJSONGitHub(meta);

        for (const url of urls) {
            try {
                const resp = await fetch(url, { cache: 'no-store' });
                if (resp.ok) {
                    const data = await resp.json();
                    estado.cacheJSONGitHub = normalizarJSON(data, meta);
                    return estado.cacheJSONGitHub;
                }
            } catch (e) {}
        }

        throw new Error(`No se encontró ${meta.materia}_${meta.num}.json en GitHub (${CONFIG.GITHUB_REPO}).`);
    }

    // =========================================================================
    // 7. DOM DE EJERCICIOS Y CONSULTA DE VARIANTES EN EL JSON
    // =========================================================================
    function obtenerNotaEjercicio(ej) {
        const inp = ej.querySelector('input.notas, input.itmostrar.notas');
        if (!inp) return 0;
        const val = parseFloat(inp.value || inp.getAttribute('value') || '0');
        return isNaN(val) ? 0 : val;
    }

    function obtenerEstadoBotones(ej) {
        const gen = ej.querySelector('.btGenerar');
        const rep = ej.querySelector('.btRepetir');
        const cor = ej.querySelector(SEL.CORREGIR);
        return {
            generarVisible: !!(gen && esVisible(gen)),
            repetirVisible: !!(rep && esVisible(rep)),
            corregirVisible: !!(cor && esVisible(cor))
        };
    }

    function encontrarEjercicioCorriendo() {
        const ejercicios = Array.from(document.querySelectorAll('div.ejercicio[id]'));
        const sinInicio = b => !b.generarVisible && !b.repetirVisible;

        const porCorregir = ejercicios.find(ej => {
            const b = obtenerEstadoBotones(ej);
            return sinInicio(b) && b.corregirVisible;
        });
        if (porCorregir) return porCorregir;

        return ejercicios.find(ej => sinInicio(obtenerEstadoBotones(ej)) && ej.hasAttribute('enunciado')) || null;
    }

    function varianteDe(ej) {
        const n = parseInt(ej.getAttribute('enunciado'), 10);
        return isNaN(n) ? null : n;
    }

    function indiceEjercicio(ej) {
        const m = /^ejercicio(\d+)$/.exec(ej.id || '');
        return m ? Number(m[1]) - 1 : null;
    }

    function obtenerEntradaJSON(datosJSON, ej) {
        if (!datosJSON || !datosJSON.ejercicios || !ej || !ej.id) return null;
        return datosJSON.ejercicios[ej.id] || null;
    }

    function resolverCalculadorasJSON(datosJSON, ej) {
        const entrada = obtenerEntradaJSON(datosJSON, ej);
        if (!entrada) {
            return { varianteObjetivo: null, calculadoras: null, noExisteEnJSON: true, varianteFaltante: false };
        }

        const varActual = varianteDe(ej);
        if (varActual !== null) {
            const clave = String(varActual);
            if (entrada.enunciados[clave]) {
                return { varianteObjetivo: varActual, calculadoras: entrada.enunciados[clave], noExisteEnJSON: false, varianteFaltante: false };
            }
            return { varianteObjetivo: null, calculadoras: null, noExisteEnJSON: false, varianteFaltante: true };
        }

        const primeraClave = entrada.variantes[0];
        const numObjetivo = /^\d+$/.test(primeraClave) ? parseInt(primeraClave, 10) : null;
        return {
            varianteObjetivo: numObjetivo,
            calculadoras: entrada.enunciados[primeraClave] || null,
            noExisteEnJSON: false,
            varianteFaltante: false
        };
    }

    // =========================================================================
    // 7B. VARIANTE FORZADA (elige qué enunciado se genera, solo para un ejercicio)
    // =========================================================================
    const forzado = { original: null, variantes: new Map() };

    function generarConVariante(original, ctx, args, variante) {
        if (typeof Capitulo !== 'undefined' && Capitulo.reg && Capitulo.reg[Ejercicio.neg]) {
            Capitulo.reg[Ejercicio.neg][0] = 0;
        }
        const total = ctx.enunciados ? ctx.enunciados.length : 1;
        const segura = Math.min(variante, total - 1);
        if (segura !== variante) console.warn(`[Inyector] Variante ${variante} fuera de rango (${total}); se usa ${segura}.`);

        const randomOriginal = Math.random;
        Math.random = () => (segura + 0.1) / total;
        try { return original.apply(ctx, args); }
        finally { Math.random = randomOriginal; }
    }

    function instalarForzadoDeVariante() {
        if (forzado.original || typeof Ejercicio === 'undefined' || !Ejercicio.prototype) return;
        const original = Ejercicio.prototype.generarEjercicio;
        if (typeof original !== 'function') return;

        forzado.original = original;
        Ejercicio.prototype.generarEjercicio = function () {
            const variante = forzado.variantes.get(Ejercicio.neg);
            return variante === undefined
                ? original.apply(this, arguments)
                : generarConVariante(original, this, arguments, variante);
        };
    }

    function restaurarGenerarEjercicio() {
        if (!forzado.original) return;
        Ejercicio.prototype.generarEjercicio = forzado.original;
        forzado.original = null;
        forzado.variantes.clear();
    }

    async function conVarianteForzada(ej, variante, accion) {
        instalarForzadoDeVariante();
        const idx = indiceEjercicio(ej);
        const activa = variante !== null && variante !== undefined && idx !== null && !!forzado.original;
        if (activa) forzado.variantes.set(idx, variante);
        try { return await accion(); }
        finally { if (activa) forzado.variantes.delete(idx); }
    }

    // =========================================================================
    // 8. ACCIONES SOBRE BOTONES DEL EJERCICIO
    // =========================================================================
    async function clickCorregir(ej) {
        if (estado.cancelado) return false;
        const btn = habilitarCorregir(ej);
        if (!btn) return false;
        btn.click();
        await sleep(CONFIG.PAUSA_TRAS_CORREGIR_MS);
        return true;
    }

    async function clickYEsperarCambio(ej, boton) {
        const antes = ej.innerHTML;
        boton.click();
        await esperarHasta(() => ej.innerHTML !== antes, 2500);
        await sleep(150);
    }

    async function iniciarOReiniciar(ej, intento, variante = null) {
        const gen = ej.querySelector('.btGenerar');
        const rep = ej.querySelector('.btRepetir');
        const usarGenerar = intento === 0 && gen && esVisible(gen) && !(rep && esVisible(rep));
        const boton = usarGenerar ? gen : rep;
        if (boton) await conVarianteForzada(ej, variante, () => clickYEsperarCambio(ej, boton));
    }

    // =========================================================================
    // 9. RESPUESTAS DIRECTAS DESDE EL OBJETO `capitulo`
    // =========================================================================
    const b64 = {
        d: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz<>",
        d4c(e) {
            let t, r, a = [], i = "";
            for (let o = 0; o < 4; o++) {
                t = this.d.indexOf(e[3 - o]);
                for (let j = 0; j < 6; j++) a.unshift((t >> j) & 1);
            }
            const bin = a.join("");
            for (let j = 0; j < 3; j++) {
                r = parseInt(bin.slice(8 * j, 8 * (j + 1)), 2);
                i += String.fromCharCode(r);
            }
            return i;
        },
        d4cf(e) {
            let t, r, a = [], i = "";
            for (let o = 0; o < 4; o++) {
                t = e[3 - o] ? this.d.indexOf(e[3 - o]) : 0;
                for (let j = 0; j < 6; j++) a.unshift((t >> j) & 1);
            }
            const bin = a.join("");
            for (let j = 0; j < 3; j++) {
                r = parseInt(bin.slice(8 * j, 8 * (j + 1)), 2);
                if (r !== 0) i += String.fromCharCode(r);
            }
            return i;
        },
        decode(e) {
            let t = 0, r = "";
            while (t < e.length - 4) {
                r += this.d4c(e.substring(t, t + 4));
                t += 4;
            }
            return r + this.d4cf(e.substring(t, t + 4));
        }
    };

    const limpiarComandosProfesor = t => t.replace(/_\^/g, '').replace(/_\$/g, '');

    function obtenerPreguntasEjercicio(ej) {
        const m = /^ejercicio(\d+)$/.exec(ej.id || '');
        if (!m || typeof capitulo === 'undefined' || !capitulo.ejercicios) return null;
        const data = capitulo.ejercicios[Number(m[1]) - 1];
        return (data && data.preguntas && data.preguntas[data.enunciado]) || null;
    }

    async function escribirLiteralDirecto(campo, texto) {
        campo.textContent = texto;
        dispararEventos(campo, ['input']);
        campo.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        dispararEventos(campo, ['change']);
        campo.blur();
        await sleep(20);
    }

    async function llenarTipoLiteral(p, literales, cursor) {
        for (const c of p.pregunta.campos) {
            const campo = literales[cursor.lit++];
            if (!campo) continue;
            await escribirLiteralDirecto(campo, limpiarComandosProfesor(b64.decode(c[0])));
        }
    }

    function llenarTipoSelector(p, selectores, cursor) {
        p.pregunta.correctas.forEach(c => {
            const campo = selectores[cursor.sel++];
            if (campo) campo.textContent = b64.decode(c);
        });
    }

    function marcarTipoRadio(p) {
        const visible = p.pregunta.visibles.find(v => v[0] === p.pregunta.correcta[0]);
        const radio = visible && document.getElementById(visible[1]);
        if (radio && !radio.checked) radio.click();
    }

    function marcarTipoChecks(p) {
        p.pregunta.forEach(opt => {
            const cb = document.getElementById(opt.id);
            if (cb && cb.checked !== (opt.tipo === 1)) cb.click();
        });
    }

    async function llenarCamposDesdeCapitulo(ej) {
        const preguntas = obtenerPreguntasEjercicio(ej);
        if (!preguntas) return false;

        const literales = ej.querySelectorAll('.campo_literal');
        const selectores = ej.querySelectorAll(SEL.SELECTORES);
        const cursor = { lit: 0, sel: 0 };

        for (const p of preguntas) {
            if (estado.cancelado) return true;
            if (p.tipo === 4) await llenarTipoLiteral(p, literales, cursor);
            else if (p.tipo === 2 || p.tipo === 3) llenarTipoSelector(p, selectores, cursor);
            else if (p.tipo === 0) marcarTipoRadio(p);
            else if (p.tipo === 1) marcarTipoChecks(p);
        }
        return true;
    }

    // =========================================================================
    // 10. CALCULADORAS (CodeMirror) Y DIAGRAMAS GOJS DESDE JSON
    // =========================================================================
    const esDiagramaVivo = c => !!c.querySelector('canvas') || /gojsGraph\s*\(/.test(c.textContent);

    async function escribirCelda(liveCalc, indice, texto) {
        if (!texto || estado.cancelado) return;
        const obtener = () => liveCalc.querySelectorAll('.CodeMirror')[indice];
        let liveCM = obtener();
        if (!liveCM) {
            await esperarHasta(obtener, 2000);
            liveCM = obtener();
        }
        if (liveCM && liveCM.CodeMirror) {
            const cm = liveCM.CodeMirror;
            cm.setValue(texto);
            dispararShiftEnter(cm.getInputField(), ['keydown']);
            await sleep(120);
        }
    }

    function contarCeldasConContenido(calc) {
        const n = Array.from(calc.querySelectorAll('.CodeMirror'))
            .filter(cm => cm.CodeMirror && cm.CodeMirror.getValue().trim() !== '').length;
        return Math.max(1, n);
    }

    function planificarCalculadorasJSON(liveNoDiag, srcNoDiag) {
        const plan = new Map();
        if (liveNoDiag.length === srcNoDiag.length) {
            liveNoDiag.forEach((c, j) => plan.set(c, (srcNoDiag[j] && srcNoDiag[j].instrucciones) || []));
            return plan;
        }
        const todas = srcNoDiag.flatMap(c => (c && c.instrucciones) || []).filter(Boolean);
        const cupo = liveNoDiag.map(contarCeldasConContenido);
        liveNoDiag.forEach((c, j) =>
            plan.set(c, j === liveNoDiag.length - 1 ? todas.splice(0) : todas.splice(0, cupo[j])));
        return plan;
    }

    function limpiarComodines(t) {
        if (typeof t !== 'string' || !t.includes('_(')) return t;
        return t.replace(/_\(([\s\S]*?)_\)/g, (m, inner) => inner.split('_|')[0].replace(/_/g, ''))
                .replace(/[ \t]{2,}/g, ' ').trim();
    }

    function extraerModeloGoJS(texto) {
        if (!texto) return null;
        const ini = texto.lastIndexOf('{"class":"go.GraphLinksModel"');
        if (ini === -1) return null;

        let prof = 0, enCadena = false, escape = false;
        for (let i = ini; i < texto.length; i++) {
            const ch = texto[i];
            if (enCadena) {
                if (escape) escape = false;
                else if (ch === '\\') escape = true;
                else if (ch === '"') enCadena = false;
                continue;
            }
            if (ch === '"') { enCadena = true; continue; }
            if (ch === '{') prof++;
            else if (ch === '}' && --prof === 0) {
                try { return JSON.parse(texto.slice(ini, i + 1)); } catch (e) { return null; }
            }
        }
        return null;
    }

    function diagramaDe(calc) {
        const cv = calc.querySelector('canvas');
        if (!cv || !window.go || !window.go.Diagram) return null;
        for (let el = cv; el; el = el.parentElement) {
            const d = window.go.Diagram.fromDiv(el);
            if (d) return d;
        }
        return null;
    }

    function quitarEnlaces(m) {
        const viejos = [...m.linkDataArray];
        if (m.removeLinkDataCollection) m.removeLinkDataCollection(viejos);
        else viejos.forEach(l => m.removeLinkData(l));
    }

    function aplicarNodos(m, nodos) {
        nodos.forEach(src => {
            const texto = limpiarComodines(src.text);
            const existente = m.findNodeDataForKey(src.key);
            if (existente) {
                if (src.text !== undefined) m.setDataProperty(existente, 'text', texto);
            } else {
                const copia = JSON.parse(JSON.stringify(src));
                copia.text = texto;
                m.addNodeData(copia);
            }
        });
    }

    function aplicarEnlaces(m, enlaces) {
        enlaces.forEach(l => {
            const copia = JSON.parse(JSON.stringify(l));
            if (typeof copia.text === 'string') copia.text = limpiarComodines(copia.text);
            m.addLinkData(copia);
        });
    }

    function inyectarModelo(d, modelo) {
        const m = d.model;
        d.startTransaction('InyeccionModelo');
        try {
            quitarEnlaces(m);
            aplicarNodos(m, modelo.nodeDataArray || []);
            aplicarEnlaces(m, modelo.linkDataArray || []);
            d.commitTransaction('InyeccionModelo');
            return true;
        } catch (e) {
            try { d.rollbackTransaction(); } catch (e2) {}
            return false;
        }
    }

    async function rellenarDiagramaComoTexto(liveCalc, instrucciones) {
        const textos = (instrucciones || []).map(limpiarComodines);
        for (let k = 0; k < textos.length; k++) await escribirCelda(liveCalc, k, textos[k]);
    }

    async function procesarDiagramaJSON(liveCalc, srcCalc) {
        const modelo = (srcCalc && srcCalc.modelo) || extraerModeloGoJS(liveCalc.textContent);
        const instrucciones = (srcCalc && srcCalc.instrucciones) || [];

        if (modelo) {
            await esperarHasta(() => diagramaDe(liveCalc), 2500);
            const d = diagramaDe(liveCalc);
            if (d && inyectarModelo(d, modelo)) {
                await sleep(60);
                dispararShiftEnter(liveCalc.querySelector('canvas'));
                return;
            }
        }
        await rellenarDiagramaComoTexto(liveCalc, instrucciones);
    }

    async function llenarCalculadorasDesdeJSON(ejActual, calculadorasJSON) {
        const live = Array.from(ejActual.querySelectorAll('.calculadora'));
        if (!live.length) return;
        const listaJSON = Array.isArray(calculadorasJSON) ? calculadorasJSON : [];

        const srcDiag = listaJSON.filter(c => c && (c.tipo === 'diagrama' || !!c.modelo));
        const srcNoDiag = listaJSON.filter(c => c && c.tipo !== 'diagrama' && !c.modelo);
        const liveNoDiag = live.filter(c => !esDiagramaVivo(c));
        const plan = planificarCalculadorasJSON(liveNoDiag, srcNoDiag);

        let idxDiag = 0;
        for (const liveCalc of live) {
            if (estado.cancelado) return;
            if (esDiagramaVivo(liveCalc)) {
                const srcCalc = srcDiag[idxDiag++];
                if (!srcCalc) continue;
                await procesarDiagramaJSON(liveCalc, srcCalc);
            } else {
                const textos = plan.get(liveCalc) || [];
                for (let k = 0; k < textos.length; k++) await escribirCelda(liveCalc, k, textos[k]);
            }
        }
    }

    // =========================================================================
    // 11. RELLENO COMPLETO DE UN EJERCICIO
    // =========================================================================
    async function rellenarContenidoEjercicio(ejActual, calculadorasJSON) {
        await llenarCamposDesdeCapitulo(ejActual);
        if (estado.cancelado || !Array.isArray(calculadorasJSON)) return;

        await llenarCalculadorasDesdeJSON(ejActual, calculadorasJSON);
        await sleep(100);
    }

    // =========================================================================
    // 12. INTERFAZ GRÁFICA
    // =========================================================================
    const ui = {};
    const ICONO_DESCARGA = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

    function crearElemento(tag, estilos = {}, props = {}) {
        const el = document.createElement(tag);
        Object.assign(el, props);
        Object.assign(el.style, estilos);
        return el;
    }

    function crearSeccionInfo(texto) {
        return crearElemento('div', {
            background: '#1e293b', color: '#38bdf8', padding: '5px 8px', fontSize: '11px',
            fontWeight: '700', textAlign: 'center', border: '1px solid #334155',
            borderRadius: '0px', letterSpacing: '0.5px'
        }, { textContent: texto });
    }

    function crearContadorDefensa() {
        return crearElemento('div', {
            display: 'none', background: '#0f172a', color: '#facc15', padding: '4px 8px',
            fontSize: '11px', fontWeight: '700', fontFamily: 'monospace', textAlign: 'center',
            border: '1px solid #334155', borderRadius: '0px'
        }, { textContent: 'Espera envío: 00:00:00' });
    }

    function crearSelectorModo() {
        const sel = crearElemento('select', {
            padding: '6px 12px', background: '#1e293b', color: '#e2e8f0',
            border: '1px solid #475569', borderRadius: '999px', fontSize: '11px',
            fontWeight: '500', cursor: 'pointer', outline: 'none'
        }, { title: 'Modo de inyección' });

        const valores = ['no_iniciados', 'iniciados', 'sin_corregir', 'todos'];
        const textos = ['Solo no iniciados', 'Solo iniciados (<100)', 'Sin corregir (en curso)', 'Todos'];
        valores.forEach((v, i) => sel.appendChild(crearElemento('option', {}, { value: v, textContent: textos[i] })));
        return sel;
    }

    function crearBotonGitHub() {
        return crearElemento('button', {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '32px', height: '32px', background: '#2563eb', color: '#ffffff',
            border: 'none', borderRadius: '50%', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.4)', transition: 'all 0.2s ease', padding: '0'
        }, { innerHTML: ICONO_DESCARGA, title: 'Cargar JSON desde GitHub (DEF) e inyectar' });
    }

    function crearBotonLocal() {
        return crearElemento('button', {
            padding: '6px 12px', background: '#334155', color: 'white', border: 'none',
            borderRadius: '999px', cursor: 'pointer', fontSize: '11px', fontWeight: '600'
        }, { textContent: 'JSON Local', title: 'Elegir archivo .json local' });
    }

    function crearBotonCerrar() {
        return crearElemento('button', {
            width: '28px', height: '28px', background: '#ef4444', color: 'white', border: 'none',
            borderRadius: '50%', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }, { textContent: '✕' });
    }

    function crearPestana() {
        return crearElemento('button', {
            width: '16px', height: '36px', background: 'transparent', color: 'transparent',
            border: 'none', outline: 'none', borderRadius: '0px', cursor: 'pointer', opacity: '0', padding: '0'
        });
    }

    function crearPanelMenu() {
        return crearElemento('div', {
            display: 'none', flexDirection: 'column', gap: '8px',
            background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(6px)',
            padding: '10px 12px', borderRadius: '0px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)',
            borderRight: 'none', marginRight: '0'
        });
    }

    function crearInputArchivo() {
        return crearElemento('input', { display: 'none' },
            { className: 'tm-inyectado', type: 'file', accept: '.json,application/json' });
    }

    function construirUI() {
        const meta = obtenerMetadatosCapitulo();
        const etiqueta = meta ? `${meta.materia.toUpperCase()} · Cap ${meta.num} (DEF)` : 'V37 DEF';

        const raiz = crearElemento('div', {
            position: 'fixed', bottom: '28px', right: '0', zIndex: '9999',
            display: 'flex', alignItems: 'center', fontFamily: 'system-ui, sans-serif'
        }, { className: 'tm-inyectado' });

        ui.panel = crearPanelMenu();
        ui.contadorDefensa = crearContadorDefensa();
        ui.selectModo = crearSelectorModo();
        ui.btnGitHub = crearBotonGitHub();
        ui.btnLocal = crearBotonLocal();
        ui.btnCerrar = crearBotonCerrar();
        ui.btnPestana = crearPestana();
        ui.inputFile = crearInputArchivo();

        const fila = crearElemento('div', { display: 'flex', alignItems: 'center', gap: '6px' });
        fila.append(ui.selectModo, ui.btnGitHub, ui.btnLocal, ui.btnCerrar);
        ui.panel.append(crearSeccionInfo(etiqueta), ui.contadorDefensa, fila);
        raiz.append(ui.panel, ui.btnPestana);

        document.body.appendChild(raiz);
        document.body.appendChild(ui.inputFile);
    }

    function alternarMenu() {
        estado.menuAbierto = !estado.menuAbierto;
        ui.panel.style.display = estado.menuAbierto ? 'flex' : 'none';
        if (estado.menuAbierto && estado.esperaDefensaActiva) {
            actualizarContadorPanel();
        }
    }

    function mostrarProgreso(texto) {
        ui.btnGitHub.innerHTML = `<span style="font-size:10px; font-weight:bold;">${texto}</span>`;
    }

    function bloquearUI() {
        ui.btnGitHub.disabled = true;
        ui.btnLocal.disabled = true;
        ui.selectModo.disabled = true;
        ui.btnGitHub.style.opacity = '0.7';
        mostrarProgreso('...');
    }

    function resetearUI() {
        desactivarEscudoFoco();
        if (estado.cancelado) return;
        ui.btnGitHub.disabled = false;
        ui.btnLocal.disabled = false;
        ui.selectModo.disabled = false;
        ui.btnGitHub.innerHTML = ICONO_DESCARGA;
        ui.btnGitHub.style.opacity = '1';
    }

    // =========================================================================
    // 13. VALIDACIÓN Y ORQUESTACIÓN (MODO EN CURSO Y MODOS MASIVOS)
    // =========================================================================
    const necesitaCalculadora = ej => !!ej.querySelector('.calculadora');

    function validarJSONContraPagina(datosJSON) {
        const meta = obtenerMetadatosCapitulo();
        const capPag = extraerNumCapTitulo(document.title) || (meta && meta.num);
        if (datosJSON.capituloNum && capPag && String(datosJSON.capituloNum) !== String(capPag)) {
            return `Error: JSON de cap ${datosJSON.capituloNum}, pero estás en cap ${capPag}.`;
        }
        if (datosJSON.materia && meta && datosJSON.materia.toLowerCase() !== meta.materia.toLowerCase()) {
            return `Error: JSON de ${datosJSON.materia}, pero estás en ${meta.materia}.`;
        }
        return null;
    }

    async function procesarModoEnCurso(datosJSON) {
        const ej = encontrarEjercicioCorriendo();
        if (!ej) {
            showToast('No hay ningún ejercicio corriendo en este momento.', 'warning');
            return;
        }

        const res = resolverCalculadorasJSON(datosJSON, ej);
        if (res.noExisteEnJSON && necesitaCalculadora(ej)) {
            showToast(`Este ejercicio (${ej.id}) no está en el JSON.`, 'warning');
            return;
        }
        if (res.varianteFaltante && necesitaCalculadora(ej)) {
            showToast(`Variante ${varianteDe(ej)} de ${ej.id} no guardada en el JSON.`, 'warning');
            return;
        }

        mostrarProgreso(1);
        await rellenarContenidoEjercicio(ej, res.calculadoras);
    }

    function debeProcesarEjercicio(modo, ej) {
        const b = obtenerEstadoBotones(ej);
        if (modo === 'no_iniciados') return !b.repetirVisible && b.generarVisible;
        if (modo === 'iniciados') return b.repetirVisible && obtenerNotaEjercicio(ej) < 100;
        return b.generarVisible || b.repetirVisible;
    }

    async function procesarEjercicio(datosJSON, ej) {
        const entrada = obtenerEntradaJSON(datosJSON, ej);
        if (!entrada && necesitaCalculadora(ej)) return false;

        for (let intento = 0; intento < CONFIG.MAX_INTENTOS; intento++) {
            if (estado.cancelado) return false;

            const prevRes = resolverCalculadorasJSON(datosJSON, ej);
            await iniciarOReiniciar(ej, intento, prevRes.varianteObjetivo);
            if (estado.cancelado) return false;

            const postRes = resolverCalculadorasJSON(datosJSON, ej);
            if (postRes.varianteFaltante) {
                console.warn(`[Inyector] ${ej.id}: salió variante ${varianteDe(ej)} sin datos en JSON, reintentando.`);
                await clickCorregir(ej);
                continue;
            }

            await rellenarContenidoEjercicio(ej, postRes.calculadoras);
            await clickCorregir(ej);
            return true;
        }
        return false;
    }

    async function procesarModoMasivo(datosJSON, modo) {
        const ejercicios = Array.from(document.querySelectorAll('div.ejercicio[id]'));
        let procesados = 0, omitidos = 0;

        for (let i = 0; i < ejercicios.length; i++) {
            if (estado.cancelado) return;
            const ej = ejercicios[i];
            if (!ej.id) continue;

            if (!debeProcesarEjercicio(modo, ej)) { omitidos++; continue; }

            mostrarProgreso(i + 1);
            if (await procesarEjercicio(datosJSON, ej)) procesados++;
        }

        if (procesados === 0 && omitidos > 0) showToast(`No se inyectó nada: ${omitidos} omitidos por filtros.`, 'info');
        else if (procesados === 0) showToast('Ningún ejercicio coincide con el JSON.', 'warning');
    }

    async function ejecutarInyeccionConJSON(datosJSON) {
        const error = validarJSONContraPagina(datosJSON);
        if (error) { showToast(error, 'error'); return resetearUI(); }

        activarEscudoFoco();
        const modo = ui.selectModo.value;

        if (modo === 'sin_corregir') await procesarModoEnCurso(datosJSON);
        else await procesarModoMasivo(datosJSON, modo);

        if (!estado.cancelado) resetearUI();
    }

    // =========================================================================
    // 14. HANDLERS DE BOTONES
    // =========================================================================
    async function alClickGitHub() {
        if (ui.btnGitHub.disabled) return;
        const meta = obtenerMetadatosCapitulo();
        if (!meta) { showToast('Error: Metadatos no detectados.', 'error'); return; }

        bloquearUI();
        try {
            const datosJSON = await cargarJSONDesdeGitHub(meta);
            await ejecutarInyeccionConJSON(datosJSON);
        } catch (err) {
            showToast(err.message || 'Error al cargar JSON de GitHub.', 'error');
            resetearUI();
        }
    }

    function alClickLocal() {
        if (!ui.btnLocal.disabled) ui.inputFile.click();
    }

    function alElegirArchivo() {
        const file = ui.inputFile.files[0];
        if (!file) return;

        bloquearUI();
        const meta = obtenerMetadatosCapitulo();
        const reader = new FileReader();
        reader.onload = async e => {
            ui.inputFile.value = '';
            try {
                const parsed = JSON.parse(e.target.result);
                const datosJSON = normalizarJSON(parsed, meta);
                await ejecutarInyeccionConJSON(datosJSON);
            } catch (err) {
                showToast(err.message || 'Error: JSON inválido.', 'error');
                resetearUI();
            }
        };
        reader.readAsText(file);
    }

    // =========================================================================
    // 15. INICIALIZACIÓN
    // =========================================================================
    function conectarEventos() {
        document.addEventListener('click', interceptarGuardar, true);
        document.addEventListener('click', alHacerClic, true);
        document.addEventListener('click', interceptarGenerarDefensa, true);
        ui.btnCerrar.addEventListener('click', limpiarRastro);
        ui.btnPestana.addEventListener('click', alternarMenu);
        ui.btnGitHub.addEventListener('click', alClickGitHub);
        ui.btnLocal.addEventListener('click', alClickLocal);
        ui.inputFile.addEventListener('change', alElegirArchivo);
    }

    function iniciar() {
        envolverSavePage();
        instalarForzadoDeVariante();
        construirUI();
        conectarEventos();
    }

    iniciar();
})();
