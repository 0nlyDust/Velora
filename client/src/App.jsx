import React, { useEffect, useMemo, useState } from "react";
import { Plus, PieChart, Target, Sparkles, ShieldCheck, ArrowUpRight, ArrowDownRight, LogOut, Trash2, Heart, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { PieChart as RPieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line } from "recharts";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";
const defaultBudgetTemplate = { Ahorro: 150, Impuestos: 80, Gobierno: 80, Facturas: 180, Coche: 120, Supermercado: 320, Comida: 180, Vivienda: 700, Transporte: 120, Viajes: 120, Shopping: 160, Suscripciones: 60, Seguros: 90, Ocio: 160, Salud: 100, Belleza: 120, Inversión: 250, Transferencias: 80, Otros: 80 };
const chartColors = ["#ec4899", "#a855f7", "#fb7185", "#f97316", "#14b8a6", "#60a5fa", "#facc15", "#86efac", "#38bdf8", "#818cf8", "#94a3b8"];

function monthKey(date) { return String(date).slice(0, 7); }
function yearKey(date) { return String(date).slice(0, 4); }
function today() { return new Date().toISOString().slice(0, 10); }
function currentMonth() { return today().slice(0, 7); }
function currentYear() { return today().slice(0, 4); }

function addMonths(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function dayKey(date) { return String(date).slice(0, 10); }
function monthName(month) {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
}
function eur(value) { return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value || 0); }
function hexToRgba(hex = "#ec4899", alpha = 0.12) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const n = parseInt(full || "ec4899", 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function categoryMeta(categories, name) { return categories.find(c => c.name === name) || { emoji: "✨", color: "#ec4899" }; }

function MetricCard({ title, value, icon: Icon, tone, helper }) {
  return <div className="metric-card"><div className="metric-header"><div><p className="muted">{title}</p><p className={`metric-value ${tone || ""}`}>{value}</p>{helper && <p className="helper">{helper}</p>}</div><div className="icon-box"><Icon size={22} /></div></div></div>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [budgets, setBudgets] = useState(defaultBudgetTemplate);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [selectedYear, setSelectedYear] = useState(currentYear());
  const [tab, setTab] = useState("dashboard");
  const [expandedDate, setExpandedDate] = useState(today());
  const [newTx, setNewTx] = useState({ date: today(), description: "", amount: "", source: "Manual", category: "" });
  const [newCategory, setNewCategory] = useState({ name: "", emoji: "✨", color: "#ec4899" });
  const [status, setStatus] = useState("Velora lista para cuidar tu dinero.");

  async function api(path, options = {}) {
    const token = localStorage.getItem("velora_token");

    const res = await fetch(`${API}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401) {
        localStorage.removeItem("velora_token");
      }
      throw new Error(data.error || "Error inesperado");
    }

    return data;
  }

  async function loadAll() {
    const [tx, cats, b] = await Promise.all([
      api(`/api/transactions?year=${selectedYear}`),
      api("/api/categories"),
      api(`/api/budgets?month=${selectedMonth}`)
    ]);
    setTransactions(tx.results || []);
    setCategories(cats.results || []);
    const loaded = { ...defaultBudgetTemplate };
    (b.results || []).forEach(row => { loaded[row.category] = Number(row.amount); });
    setBudgets(loaded);
  }

  useEffect(() => {
    api("/api/auth/me").then(d => setUser(d.user)).catch(() => setUser(null));
    const params = new URLSearchParams(window.location.search);
  }, []);

  useEffect(() => { if (user) loadAll().catch(e => setStatus(e.message)); }, [user, selectedMonth, selectedYear]);

  const monthTransactions = useMemo(() => transactions.filter((t) => monthKey(t.date) === selectedMonth), [transactions, selectedMonth]);
  const yearTransactions = useMemo(() => transactions.filter((t) => yearKey(t.date) === selectedYear), [transactions, selectedYear]);

  const monthSummary = useMemo(() => {
    const income = monthTransactions.filter((t) => t.amount > 0).reduce((a, t) => a + Number(t.amount), 0);
    const expenses = Math.abs(monthTransactions.filter((t) => t.amount < 0).reduce((a, t) => a + Number(t.amount), 0));
    return { income, expenses, balance: income - expenses, savingsRate: income ? Math.round(((income - expenses) / income) * 100) : 0 };
  }, [monthTransactions]);

  const byCategory = useMemo(() => {
    const map = {};
    monthTransactions.filter((t) => t.amount < 0).forEach((t) => { map[t.category] = (map[t.category] || 0) + Math.abs(Number(t.amount)); });
    return Object.entries(map).map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }));
  }, [monthTransactions]);



  const pieCategoryData = useMemo(() => {
    const total = byCategory.reduce((sum, item) => sum + item.value, 0);
    const main = [];
    let small = 0;
    byCategory.forEach(item => {
      if (total && item.value / total < 0.035) small += item.value;
      else main.push(item);
    });
    if (small > 0) main.push({ name: "Pequeños gastos", value: Number(small.toFixed(2)) });
    return main;
  }, [byCategory]);
  const monthlyYearData = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const m = `${selectedYear}-${String(i + 1).padStart(2, "0")}`;
    const txs = transactions.filter((t) => monthKey(t.date) === m);
    const ingresos = txs.filter((t) => t.amount > 0).reduce((a, t) => a + Number(t.amount), 0);
    const gastos = Math.abs(txs.filter((t) => t.amount < 0).reduce((a, t) => a + Number(t.amount), 0));
    return { month: m.slice(5), ingresos, gastos, balance: ingresos - gastos };
  }), [transactions, selectedYear]);

  const calendarDays = useMemo(() => {
    const [year, month] = selectedMonth.split("-").map(Number);
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const startOffset = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${selectedMonth}-${String(day).padStart(2, "0")}`;
      const txs = monthTransactions.filter(t => dayKey(t.date) === date);
      const income = txs.filter(t => Number(t.amount) > 0).reduce((sum, t) => sum + Number(t.amount), 0);
      const expense = Math.abs(txs.filter(t => Number(t.amount) < 0).reduce((sum, t) => sum + Number(t.amount), 0));
      cells.push({ date, day, txs, income, expense, net: income - expense });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [selectedMonth, monthTransactions]);

  const selectedDayTransactions = useMemo(() => monthTransactions.filter(t => dayKey(t.date) === expandedDate), [monthTransactions, expandedDate]);

  const budgetData = useMemo(() => Object.entries(budgets).map(([category, limit]) => {
    const spent = byCategory.find((c) => c.name === category)?.value || 0;
    return { category, limit: Number(limit), spent, remaining: Number(limit) - spent, pct: limit ? Math.min(100, Math.round((spent / Number(limit)) * 100)) : 0 };
  }), [budgets, byCategory]);

  const insights = useMemo(() => {
    const top = [...byCategory].sort((a, b) => b.value - a.value)[0];
    const overs = budgetData.filter(b => b.spent > b.limit && b.limit > 0).sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit));
    const otrosPct = monthSummary.expenses ? Math.round(((byCategory.find(c => c.name === "Otros")?.value || 0) / monthSummary.expenses) * 100) : 0;
    return { top, overs, otrosPct };
  }, [byCategory, budgetData, monthSummary.expenses]);

  const totalBudget = Object.values(budgets).reduce((a, b) => a + Number(b || 0), 0);
  const yearBalance = yearTransactions.reduce((a, t) => a + Number(t.amount), 0);

  async function submitAuth(e) {
    e.preventDefault();

    try {
      const data = await api(`/api/auth/${authMode === "login" ? "login" : "register"}`, {
        method: "POST",
        body: JSON.stringify(authForm),
      });

      if (data.token) {
        localStorage.setItem("velora_token", data.token);
      }

      setUser(data.user);
      setStatus(`Hola ${data.user.name}. Todo listo para organizar tus gastos.`);
    } catch (error) {
      setStatus(error.message);
    }
  }


  async function seedDemoData() {
    try {
      setStatus("Cargando datos demo…");

      const data = await api("/api/demo/seed", {
        method: "POST",
      });

      await loadAll();

      setStatus(
        `Demo cargada: ${data.transactions || 0} movimientos y presupuestos editables.`
      );
    } catch (error) {
      setStatus(error.message);
    }
  }
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("velora_token");
    setUser(null);
    setTransactions([]);
    setStatus("Sesión cerrada.");
  }

  async function addTransaction() {
    const amount = Number(newTx.amount);
    if (!newTx.description || !newTx.date || Number.isNaN(amount) || amount === 0) return setStatus("Completa fecha, descripción e importe.");
    const tx = await api("/api/transactions", { method: "POST", body: JSON.stringify({ ...newTx, amount, category: newTx.category || undefined }) });
    setTransactions(prev => [{ ...tx, amount: Number(tx.amount) }, ...prev]);
    setNewTx({ ...newTx, description: "", amount: "" });
    setStatus("Movimiento guardado.");
  }

  async function deleteTransaction(id) {
    await api(`/api/transactions/${id}`, { method: "DELETE" });
    setTransactions(prev => prev.filter(t => t.id !== id));
  }


  async function updateTransactionCategory(id, category) {
    const updated = await api(`/api/transactions/${id}/category`, { method: "PUT", body: JSON.stringify({ category }) });
    setTransactions(prev => prev.map(t => t.id === id ? { ...updated, amount: Number(updated.amount) } : t));
    setStatus(`Aprendido: movimientos parecidos se clasificarán como ${category}.`);
  }


  async function updateBudget(category, amount) {
    setBudgets(prev => ({ ...prev, [category]: amount }));
    await api("/api/budgets", { method: "PUT", body: JSON.stringify({ month: selectedMonth, category, amount: Number(amount) }) });
  }

  async function addCategory() {
    if (!newCategory.name.trim()) return;
    const cat = await api("/api/categories", { method: "POST", body: JSON.stringify(newCategory) });
    setCategories(prev => [...prev.filter(c => c.name !== cat.name), cat]);
    setBudgets(prev => ({ ...prev, [cat.name]: prev[cat.name] || 100 }));
    setNewCategory({ name: "", emoji: "✨", color: "#ec4899" });
  }






  if (!user) {
    return <div className="app auth-app"><section className="auth-card"><div className="brand"><div className="brand-icon"><Heart size={26} /></div><div><p className="pill pink"><Sparkles size={15} /> Demo portfolio</p><h1>Velora</h1><p>Una forma bonita y clara de entender tus gastos, presupuestos y hábitos mensuales.</p></div></div><form className="auth-form" onSubmit={submitAuth}>{authMode === "register" && <input placeholder="Nombre" value={authForm.name} onChange={e => setAuthForm({ ...authForm, name: e.target.value })} />}<input type="email" placeholder="Email" value={authForm.email} onChange={e => setAuthForm({ ...authForm, email: e.target.value })} /><input type="password" placeholder="Contraseña" value={authForm.password} onChange={e => setAuthForm({ ...authForm, password: e.target.value })} /><button className="primary">{authMode === "login" ? "Entrar" : "Crear cuenta"}</button></form><button className="link-button" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>{authMode === "login" ? "Crear cuenta nueva" : "Ya tengo cuenta"}</button><p className="auth-status"><ShieldCheck size={16} /> {status}</p></section></div>;
  }

  return <div className="app"><main className="container"><section className="hero"><div className="hero-glow one" /><div className="hero-glow two" /><div className="hero-content"><div><div className="pill"><Sparkles size={16} /> Finanzas suaves, claras y persistentes</div><h1>Velora</h1><p>Visualiza tus gastos, ajusta presupuestos y explora tu año financiero con datos demo realistas.</p></div><div className="balance-card"><p>Balance del mes</p><strong className={monthSummary.balance >= 0 ? "positive" : "negative"}>{eur(monthSummary.balance)}</strong><div className="mini-grid"><span>Ahorro <b>{monthSummary.savingsRate}%</b></span><span>Año <b>{eur(yearBalance)}</b></span></div></div></div></section>

    <div className="topbar"><div className="safety"><ShieldCheck size={17} /> {status}</div><div className="filters"><span className="hello">{user.avatarUrl && <img src={user.avatarUrl} />} {user.name}</span><select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>{[0,1,2,3,4,5].map(i => { const d = new Date(); d.setMonth(d.getMonth() - i); const m = d.toISOString().slice(0,7); return <option key={m}>{m}</option>; })}</select><select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}><option>{currentYear()}</option><option>{Number(currentYear()) - 1}</option></select><button className="secondary demo-button" onClick={seedDemoData}><Sparkles size={16} /> Cargar demo</button><button className="secondary" onClick={logout}><LogOut size={16} /> Salir</button></div></div>

    <section className="metrics"><MetricCard title="Ingresos" value={eur(monthSummary.income)} icon={ArrowUpRight} tone="positive" helper={`Mes ${selectedMonth}`} /><MetricCard title="Gastos" value={eur(monthSummary.expenses)} icon={ArrowDownRight} tone="negative" helper={`${Math.round((monthSummary.expenses / Math.max(totalBudget, 1)) * 100)}% del presupuesto`} /><MetricCard title="Presupuesto" value={eur(totalBudget)} icon={Target} helper="Límite mensual total" /><MetricCard title="Movimientos" value={monthTransactions.length} icon={PieChart} helper="Transacciones del mes" /></section>

    <nav className="tabs">{[["dashboard","Dashboard"],["transactions","Movimientos"],["calendar","Calendario"],["budgets","Presupuestos"],["categories","Categorías"]].map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>

    {tab === "dashboard" && <section className="grid two"><div className="panel"><h2>Gastos por categoría</h2><div className="chart"><ResponsiveContainer><RPieChart><Pie data={pieCategoryData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={105} label={({ name, percent }) => percent > 0.05 ? `${name} ${(percent * 100).toFixed(0)}%` : ""}>{pieCategoryData.map((_, i) => <Cell key={i} fill={chartColors[i % chartColors.length]} />)}</Pie><Tooltip formatter={v => eur(v)} /></RPieChart></ResponsiveContainer></div></div><div className="panel"><h2>Ingresos vs gastos</h2><div className="chart"><ResponsiveContainer><BarChart data={monthlyYearData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis /><Tooltip formatter={v => eur(v)} /><Bar dataKey="ingresos" fill="#10b981" radius={[10,10,0,0]} /><Bar dataKey="gastos" fill="#ec4899" radius={[10,10,0,0]} /></BarChart></ResponsiveContainer></div></div><div className="panel wide"><h2>Balance mensual</h2><div className="chart"><ResponsiveContainer><LineChart data={monthlyYearData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis /><Tooltip formatter={v => eur(v)} /><Line type="monotone" dataKey="balance" stroke="#a855f7" strokeWidth={4} dot={{ r: 5 }} /></LineChart></ResponsiveContainer></div></div></section>}

    {tab === "calendar" && <section className="calendar-layout"><div className="panel calendar-panel"><div className="calendar-head"><button className="secondary" onClick={() => { const m = addMonths(selectedMonth, -1); setSelectedMonth(m); setExpandedDate(`${m}-01`); }}><ChevronLeft size={16} /> Mes anterior</button><div><h2><CalendarDays size={21} /> Calendario mensual</h2><p>{monthName(selectedMonth)}</p></div><button className="secondary" onClick={() => { const m = addMonths(selectedMonth, 1); setSelectedMonth(m); setExpandedDate(`${m}-01`); }}>Mes siguiente <ChevronRight size={16} /></button></div><div className="calendar-weekdays">{["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(d => <b key={d}>{d}</b>)}</div><div className="month-calendar">{calendarDays.map((cell, i) => cell ? <button type="button" className={`calendar-day ${cell.date === today() ? "today" : ""} ${cell.date === expandedDate ? "selected" : ""}`} key={cell.date} onClick={() => setExpandedDate(cell.date)}><div className="day-top"><strong>{cell.day}</strong><span>{cell.txs.length ? `${cell.txs.length} mov.` : ""}</span></div><div className="day-summary">{cell.income > 0 && <small className="positive">+{eur(cell.income)}</small>}{cell.expense > 0 && <small className="negative">-{eur(cell.expense)}</small>}</div><div className="day-net"><b className={cell.net >= 0 ? "positive" : "negative"}>{cell.txs.length ? eur(cell.net) : ""}</b></div></button> : <div className="calendar-day empty" key={`empty-${i}`} />)}</div></div><aside className="panel day-detail"><h2>{expandedDate ? `Movimientos del ${expandedDate}` : "Elige un día"}</h2>{selectedDayTransactions.length ? <div className="daily-list">{selectedDayTransactions.map(t => { const meta = categoryMeta(categories, t.category); return <div className="daily-item" key={t.id}><div><strong>{t.description}</strong><span className="badge" style={{ background: hexToRgba(meta.color, 0.12), color: meta.color, borderColor: hexToRgba(meta.color, 0.35) }}>{meta.emoji} {t.category}</span></div><b className={t.amount >= 0 ? "positive" : "negative"}>{eur(t.amount)}</b></div>; })}</div> : <p className="empty-state">No hay movimientos este día.</p>}</aside></section>}

    {tab === "transactions" && <section className="stack"><div className="panel form-grid"><input type="date" value={newTx.date} onChange={e => setNewTx({ ...newTx, date: e.target.value })} /><input placeholder="Descripción" value={newTx.description} onChange={e => setNewTx({ ...newTx, description: e.target.value })} /><input placeholder="Importe, ej. -25.50" value={newTx.amount} onChange={e => setNewTx({ ...newTx, amount: e.target.value })} /><select value={newTx.category} onChange={e => setNewTx({ ...newTx, category: e.target.value })}><option value="">Auto inteligente</option>{categories.map(c => <option key={c.id}>{c.name}</option>)}</select><select value={newTx.source} onChange={e => setNewTx({ ...newTx, source: e.target.value })}><option>Manual</option><option>Efectivo</option></select><button className="primary" onClick={addTransaction}><Plus size={17} /> Añadir</button></div><div className="insight-strip"><div><Sparkles size={17} /><b>Clasificación inteligente</b><span>{insights.otrosPct}% del gasto está en Otros.</span></div>{insights.top && <div><PieChart size={17} /><b>Top gasto</b><span>{insights.top.name}: {eur(insights.top.value)}</span></div>}{insights.overs[0] && <div><Target size={17} /><b>Presupuesto alerta</b><span>{insights.overs[0].category} excedido.</span></div>}</div><div className="panel"><h2>Movimientos de {selectedMonth}</h2><div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Origen</th><th className="right">Importe</th><th></th></tr></thead><tbody>{monthTransactions.map(t => { const meta = categoryMeta(categories, t.category); return <tr key={t.id}><td>{String(t.date).slice(0,10)}</td><td><b>{t.description}</b></td><td><div className="category-picker"><label className="category-select-wrap"><span>{Number(t.category_confidence || 0) < 0.7 ? "Revisar categoría" : "Categoría"}</span><select value={t.category} onChange={e => updateTransactionCategory(t.id, e.target.value)}>{categories.map(c => <option key={c.id}>{c.name}</option>)}</select></label>{Number(t.category_confidence || 0) < 0.7 && <small className="low-confidence">Necesita revisión</small>}</div></td><td>{t.source}</td><td className={`right ${t.amount >= 0 ? "positive" : "negative"}`}><b>{eur(t.amount)}</b></td><td><button className="ghost" onClick={() => deleteTransaction(t.id)}><Trash2 size={15} /></button></td></tr> })}</tbody></table></div></div></section>}

    {tab === "budgets" && <section className="panel"><h2><Target size={20} /> Presupuestos de {selectedMonth}</h2><div className="budget-grid">{budgetData.map(b => <div key={b.category} className="budget-card"><div className="budget-top"><b>{categories.find(c => c.name === b.category)?.emoji} {b.category}</b><span>{eur(b.spent)} / {eur(b.limit)}</span></div><div className="bar"><div className={b.spent > b.limit ? "over" : "ok"} style={{ width: `${b.pct}%` }} /></div><div className="budget-edit"><input type="number" value={b.limit} onChange={e => updateBudget(b.category, e.target.value)} /><span className={b.remaining < 0 ? "negative" : "positive"}>{b.remaining < 0 ? "Exceso" : "Queda"}: {eur(Math.abs(b.remaining))}</span></div></div>)}</div></section>}

    {tab === "categories" && <section className="panel"><h2>Categorías bonitas</h2><div className="category-form"><input placeholder="Nombre" value={newCategory.name} onChange={e => setNewCategory({ ...newCategory, name: e.target.value })} /><input placeholder="Emoji" value={newCategory.emoji} onChange={e => setNewCategory({ ...newCategory, emoji: e.target.value })} /><input type="color" value={newCategory.color} onChange={e => setNewCategory({ ...newCategory, color: e.target.value })} /><button className="primary" onClick={addCategory}><Plus size={17} /> Añadir categoría</button></div><div className="category-grid">{categories.map(c => <div className="category-card" key={c.id} style={{ borderColor: c.color }}><span>{c.emoji}</span><b>{c.name}</b></div>)}</div></section>}
  </main></div>;
}
