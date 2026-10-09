"use client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import React from "react";

export interface PricePoint {
  time: string; // ISO or label
  price: number;
}

export interface TokenPriceChartProps {
  data: PricePoint[];
  timeframe: string;
  onTimeframeChange: (tf: string) => void;
  loading?: boolean;
}

const TIMEFRAMES = [
  { label: "1H", value: "1h" },
  { label: "24H", value: "24h" },
  { label: "7D", value: "7d" },
  { label: "30D", value: "30d" },
];

export function TokenPriceChart({
  data,
  timeframe,
  onTimeframeChange,
  loading,
}: TokenPriceChartProps) {
  return (
    <div className="w-full">
      <div className="flex gap-2 mb-2 justify-end">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            className={`px-2 py-1 rounded text-xs font-semibold border ${
              tf.value === timeframe
                ? "bg-primary text-white"
                : "bg-base-100 text-primary border-base-300"
            }`}
            onClick={() => onTimeframeChange(tf.value)}
            disabled={loading}
          >
            {tf.label}
          </button>
        ))}
      </div>
      <div className="h-64 bg-base-100 rounded">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            Loading chart…
          </div>
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm text-center px-4">
            No chart data available for this token yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" minTickGap={20} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} domain={["auto", "auto"]} />
              <Tooltip formatter={(v: number) => `$${v.toFixed(6)}`} />
              <Line
                type="monotone"
                dataKey="price"
                stroke="#8b5cf6"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
