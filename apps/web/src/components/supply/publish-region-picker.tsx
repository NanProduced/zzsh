"use client";

import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, MapPin, Search, X } from "lucide-react";
import { FieldError } from "./publish-dialogs";
import type { RegionOption } from "./publish-form-types";

export function RegionPicker({
  province,
  city,
  options,
  disabled,
  required = false,
  error,
  onChange,
}: {
  province: string;
  city: string;
  options: ReadonlyArray<RegionOption>;
  disabled: boolean;
  required?: boolean;
  error?: string;
  onChange: (province: string | null, city: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProvince, setActiveProvince] = useState(province);
  const searchRef = useRef<HTMLInputElement>(null);
  const provincesRef = useRef<HTMLDivElement>(null);
  const pairs = [...options, ...(province && city && !options.some((item) => item.province === province && item.city === city) ? [{ province, city }] : [])];
  const provinces = [...new Set(pairs.map((item) => item.province))];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProvinces = provinces.filter((item) => !normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery) || pairs.some((pair) => pair.province === item && pair.city.toLocaleLowerCase().includes(normalizedQuery)));
  const current = visibleProvinces.includes(activeProvince) ? activeProvince : visibleProvinces[0] ?? "";
  const cities = pairs.filter((item) => item.province === current && (!normalizedQuery || current.toLocaleLowerCase().includes(normalizedQuery) || item.city.toLocaleLowerCase().includes(normalizedQuery))).map((item) => item.city);
  const hasSelected = Boolean(province && city);
  const selected = hasSelected ? `${province} · ${city}` : "请选择省份和城市";

  useEffect(() => {
    if (province) setActiveProvince(province);
  }, [province]);

  return <div id="publish-region" tabIndex={-1} className="publish-region-field">
    <span className="publish-region-label">地区选择{required ? <span className="publish-required-mark">必填</span> : null}</span>
    <div className={`publish-region-control${hasSelected ? " has-selection" : ""}`}>
      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
          else if (province) setActiveProvince(province);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="publish-region-trigger"
            data-selected={hasSelected ? "true" : "false"}
            disabled={disabled}
            aria-invalid={Boolean(error) || undefined}
            aria-label="地区选择"
          >
            <MapPin size={16} aria-hidden="true" />
            <span>{selected}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="publish-region-popover"
            aria-label="选择地区"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
              const activeBtn = provincesRef.current?.querySelector<HTMLElement>('[data-active="true"]');
              if (typeof activeBtn?.scrollIntoView === "function") {
                activeBtn.scrollIntoView({ block: "nearest" });
              }
            }}
          >
            <div className="publish-region-search">
              <Search size={15} aria-hidden="true" />
              <label className="sr-only" htmlFor="publish-region-search-input">搜索省份或城市</label>
              <input
                id="publish-region-search-input"
                ref={searchRef}
                type="search"
                value={query}
                placeholder="搜索省份或城市"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="publish-region-search-clear"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {visibleProvinces.length ? (
              <div className="publish-region-columns">
                <div ref={provincesRef} className="publish-region-provinces" role="group" aria-label="选择省份">
                  {visibleProvinces.map((item) => (
                    <button
                      type="button"
                      key={item}
                      aria-pressed={item === current}
                      data-active={item === current}
                      data-has-selected={hasSelected && province === item ? "true" : undefined}
                      onClick={() => setActiveProvince(item)}
                    >
                      <span>{item}</span>
                      {hasSelected && province === item ? <i className="publish-region-province-dot" aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
                <div className="publish-region-cities" role="group" aria-label={`${current}城市`}>
                  <div className="publish-region-cities-head">
                    <strong>{current || "城市"}</strong>
                    <small>{cities.length} 个地区</small>
                  </div>
                  <div className="publish-region-cities-grid">
                    {cities.map((item) => {
                      const isSelected = province === current && city === item;
                      return (
                        <button
                          type="button"
                          key={`${current}-${item}`}
                          data-selected={isSelected}
                          onClick={() => {
                            onChange(current, item);
                            setOpen(false);
                            setQuery("");
                          }}
                        >
                          <span>{item}</span>
                          {isSelected ? <Check size={13} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <p className="publish-region-empty" role="status">未找到匹配的省份或城市</p>
            )}
            {hasSelected ? (
              <div className="publish-region-footer">
                <span className="publish-region-footer-current">已选：<strong>{province} · {city}</strong></span>
                <button
                  type="button"
                  className="publish-region-clear"
                  onClick={() => {
                    onChange(null, null);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  清除当前地区
                </button>
              </div>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hasSelected ? (
        <button
          type="button"
          className="publish-region-inline-clear"
          aria-label={`移除地区 ${province} ${city}`}
          title="清除已选地区"
          disabled={disabled}
          onClick={() => onChange(null, null)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
    <FieldError text={error} />
  </div>;
}
