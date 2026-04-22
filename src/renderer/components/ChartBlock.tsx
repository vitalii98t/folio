import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
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
  let spec: ChartSpec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    return <div className={styles.error}>Некоректний JSON графіка</div>;
  }

  if (!spec.data?.length) {
    return <div className={styles.error}>Графік без даних</div>;
  }

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
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      {label !== undefined && <div className={styles.tooltipLabel}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className={styles.tooltipRow}>
          <span className={styles.tooltipDot} style={{ background: p.color ?? p.payload?.fill }} />
          <span className={styles.tooltipName}>{p.name}</span>
          <span className={styles.tooltipValue}>{formatValue(p.value)}</span>
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

function formatValue(v: unknown): string {
  if (typeof v === 'number') {
    return v.toLocaleString('uk-UA', { maximumFractionDigits: 2 });
  }
  return String(v);
}
