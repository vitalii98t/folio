import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useT } from '../i18n';
import styles from '../styles/ChartBlock.module.css';

interface SeriesDef {
  key: string;
  label?: string;
  color?: string;
}

interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  xKey?: string;
  series?: SeriesDef[];
  data: Array<Record<string, any>>;
}

const PALETTE = [
  '#6dd5ed', '#2193b0', '#a5e9f5', '#ec4899',
  '#f59e0b', '#10b981', '#8b5cf6', '#64748b',
];

const AXIS_COLOR = 'rgba(255, 255, 255, 0.35)';
const GRID_COLOR = 'rgba(255, 255, 255, 0.06)';

interface Props {
  raw: string;
}

export function ChartBlock({ raw }: Props) {
  const { t } = useT();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return <div className={styles.error}>{t('chart.invalidJson')}</div>;
  }

  // The model writes this JSON — anything can come back (null, an array,
  // data as a string, rows as numbers). Validate before recharts sees it.
  if (!isPlainObject(parsed) || !Array.isArray(parsed.data) || !parsed.data.every(isPlainObject)) {
    return <div className={styles.error}>{t('chart.invalidJson')}</div>;
  }
  if (parsed.data.length === 0) {
    return <div className={styles.error}>{t('chart.noData')}</div>;
  }

  const spec: ChartSpec = {
    type: parsed.type === 'line' || parsed.type === 'pie' ? parsed.type : 'bar',
    title: typeof parsed.title === 'string' ? parsed.title : undefined,
    xKey: typeof parsed.xKey === 'string' ? parsed.xKey : undefined,
    series: Array.isArray(parsed.series)
      ? parsed.series
          .filter((s): s is Record<string, unknown> => isPlainObject(s) && typeof s.key === 'string')
          .map(s => ({
            key: s.key as string,
            label: typeof s.label === 'string' ? s.label : undefined,
            color: typeof s.color === 'string' ? s.color : undefined,
          }))
      : undefined,
    data: parsed.data as Array<Record<string, any>>,
  };

  return (
    <div className={styles.wrapper}>
      {spec.title && <div className={styles.title}>{spec.title}</div>}
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height={260}>
          {renderChart(spec)}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function renderChart(spec: ChartSpec) {
  if (spec.type === 'pie') {
    return (
      <PieChart>
        <Pie
          data={spec.data}
          dataKey="value"
          nameKey="name"
          outerRadius={90}
          innerRadius={48}
          paddingAngle={2}
          stroke="rgba(0,0,0,0.3)"
        >
          {spec.data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip />} />
        <Legend content={<ChartLegend />} />
      </PieChart>
    );
  }

  const xKey = spec.xKey ?? 'name';
  const series = (spec.series?.length ? spec.series : [{ key: 'value' }]) as SeriesDef[];

  if (spec.type === 'line') {
    return (
      <LineChart data={spec.data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis dataKey={xKey} stroke={AXIS_COLOR} tick={{ fontSize: 11 }} />
        <YAxis stroke={AXIS_COLOR} tick={{ fontSize: 11 }} />
        <Tooltip content={<ChartTooltip />} />
        {series.length > 1 && <Legend content={<ChartLegend />} />}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label ?? s.key}
            stroke={s.color ?? PALETTE[i % PALETTE.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    );
  }

  return (
    <BarChart data={spec.data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
      <CartesianGrid stroke={GRID_COLOR} vertical={false} />
      <XAxis dataKey={xKey} stroke={AXIS_COLOR} tick={{ fontSize: 11 }} />
      <YAxis stroke={AXIS_COLOR} tick={{ fontSize: 11 }} />
      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
      {series.length > 1 && <Legend content={<ChartLegend />} />}
      {series.map((s, i) => (
        <Bar
          key={s.key}
          dataKey={s.key}
          name={s.label ?? s.key}
          fill={s.color ?? PALETTE[i % PALETTE.length]}
          radius={[6, 6, 0, 0]}
        />
      ))}
    </BarChart>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  const { locale } = useT();
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      {label !== undefined && <div className={styles.tooltipLabel}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className={styles.tooltipRow}>
          <span className={styles.tooltipDot} style={{ background: p.color ?? p.payload?.fill }} />
          <span className={styles.tooltipName}>{p.name}</span>
          <span className={styles.tooltipValue}>{formatValue(p.value, locale)}</span>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ payload }: any) {
  if (!payload?.length) return null;
  return (
    <div className={styles.legend}>
      {payload.map((p: any, i: number) => (
        <span key={i} className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: p.color }} />
          {p.value}
        </span>
      ))}
    </div>
  );
}

function formatValue(v: unknown, locale: string): string {
  if (typeof v === 'number') {
    return v.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  return String(v);
}
