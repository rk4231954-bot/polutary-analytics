/**
 * Lucide icon registry. Only the icons imported here are bundled.
 * Usage: icon("bird", { size: 16 }) → SVG markup (SafeHtml).
 * To add an icon: import it from "lucide" and add it to ICONS with a kebab-case key.
 */
import {
  Activity, AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, BarChart3, Bell, Bird,
  BrainCircuit, Building2, Calendar, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  CircleCheck, ClipboardList, Clock, CloudOff, Columns3, Command, Copy, Cpu, Database, Download, Droplets, Egg,
  Eye, EyeOff, FileCheck, FileDown, FileSpreadsheet, FileText, Filter, FlaskConical, Gauge, HardDrive, HeartPulse,
  History, Inbox, Info, KeyRound, Layers, LayoutDashboard, Leaf, LineChart, Loader2, Lock, LogOut, Mail, MapPin,
  Menu, Minus, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plug, Plus, RefreshCw, Save, Scale,
  ScrollText, Search, Server, Settings, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Sprout, Stethoscope, Table2,
  Target, Thermometer, Trash2, TrendingDown, TrendingUp, Upload, UploadCloud, User, UserPlus, Users, Warehouse,
  Wheat, Wifi, WifiOff, Workflow, X, XCircle, createElement,
} from "lucide";
import { raw } from "../utils/dom.js";

const ICONS = {
  activity: Activity, "alert-triangle": AlertTriangle, "arrow-down": ArrowDown, "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight, "arrow-up": ArrowUp, "arrow-up-down": ArrowUpDown, "bar-chart": BarChart3, bell: Bell,
  bird: Bird, brain: BrainCircuit, building: Building2, calendar: Calendar, check: Check,
  "check-circle": CheckCircle2, "chevron-down": ChevronDown, "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight, "circle-alert": CircleAlert, "circle-check": CircleCheck,
  clipboard: ClipboardList, clock: Clock, "cloud-off": CloudOff, columns: Columns3, command: Command, copy: Copy,
  cpu: Cpu, database: Database, download: Download, droplets: Droplets, egg: Egg, eye: Eye, "eye-off": EyeOff,
  "file-check": FileCheck, "file-down": FileDown, "file-spreadsheet": FileSpreadsheet, "file-text": FileText,
  filter: Filter, flask: FlaskConical, gauge: Gauge, "hard-drive": HardDrive, "heart-pulse": HeartPulse,
  history: History, inbox: Inbox, info: Info, key: KeyRound, layers: Layers, dashboard: LayoutDashboard,
  leaf: Leaf, "line-chart": LineChart, loader: Loader2, lock: Lock, "log-out": LogOut, mail: Mail,
  "map-pin": MapPin, menu: Menu, minus: Minus, more: MoreHorizontal, "panel-close": PanelLeftClose,
  "panel-open": PanelLeftOpen, pencil: Pencil, play: Play, plug: Plug, plus: Plus, refresh: RefreshCw, save: Save,
  scale: Scale, scroll: ScrollText, search: Search, server: Server, settings: Settings, shield: Shield,
  "shield-alert": ShieldAlert, "shield-check": ShieldCheck, sliders: SlidersHorizontal, sprout: Sprout, stethoscope: Stethoscope,
  table: Table2, target: Target, thermometer: Thermometer, trash: Trash2, "trending-down": TrendingDown,
  "trending-up": TrendingUp, upload: Upload, "upload-cloud": UploadCloud, user: User, "user-plus": UserPlus,
  users: Users, warehouse: Warehouse, wheat: Wheat, wifi: Wifi, "wifi-off": WifiOff, workflow: Workflow, x: X,
  "x-circle": XCircle,
};

const cache = new Map();

/**
 * @param {string} name kebab-case key from ICONS
 * @param {{size?: number, strokeWidth?: number, className?: string, label?: string}} [options]
 */
export function icon(name, { size = 16, strokeWidth = 1.75, className = "", label } = {}) {
  const key = `${name}|${size}|${strokeWidth}|${className}|${label ?? ""}`;
  if (cache.has(key)) return raw(cache.get(key));
  const node = ICONS[name];
  if (!node) {
    if (import.meta.env.DEV) console.warn(`[icons] Unknown icon "${name}"`);
    return raw("");
  }
  const svg = createElement(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke-width", String(strokeWidth));
  if (className) svg.setAttribute("class", `lucide ${className}`);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  const markup = svg.outerHTML;
  cache.set(key, markup);
  return raw(markup);
}

export const iconNames = Object.keys(ICONS);
