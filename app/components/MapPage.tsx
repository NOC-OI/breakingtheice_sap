'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { ZarrLayer, type Selector } from '@carbonplan/zarr-layer';
import { allColorScales, colormapBuilder } from 'zarr-maps';
import { addOceanAndSeaLabels, bringOceanAndSeaLabelsToFront } from './mapOceanSeaLayers';
import { MapYearLegend } from './MapYearLegend';
import { DATASET_CONFIG, normalizeDatasetMode, type DatasetMode } from './mapDataset';
import { TimeSlider } from './TimeSlider';
import { StartQuestButton } from './StartQuestButton';

const ZARR_LAYER_ID = 'arctic-ice-age-layer';
const MAP_STYLE_URLS = {
  positron: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  fiord: 'https://tiles.openfreemap.org/styles/fiord'
} as const;
const DEFAULT_MAP_STYLE = 'fiord';

const ICE_COLORMAP = ['#4E5F6C', '#687582', '#83929B', '#A8B6BE', '#C7D7DE'];
const LEGEND_BINS = 5;
const QUERY_COLORMAP_STEPS = 255;
const MAX_SHADER_COLOR_STOPS = 24;
const COLORMAP_NAME_LOOKUP = new Map(allColorScales.map(name => [name.toLowerCase(), name]));

type MapStyleName = keyof typeof MAP_STYLE_URLS;

const ICE_AGE_CUSTOM_FRAG = `
  float age = age_of_sea_ice;

  if (age >= 20.5 || age <= 0.0 || age != age) {
    discard;
  }

  float bucket = clamp(floor(age), 0.0, 4.0);

  vec3 c0 = vec3(0.3059, 0.3725, 0.4235);
  vec3 c1 = vec3(0.4078, 0.4588, 0.5098);
  vec3 c2 = vec3(0.5137, 0.5725, 0.6078);
  vec3 c3 = vec3(0.6588, 0.7137, 0.7451);
  vec3 c4 = vec3(0.7804, 0.8431, 0.8706);

  vec3 baseColor;

  if (bucket < 0.5) {
    baseColor = c0;
  } else if (bucket < 1.5) {
    baseColor = c1;
  } else if (bucket < 2.5) {
    baseColor = c2;
  } else if (bucket < 3.5) {
    baseColor = c3;
  } else {
    baseColor = c4;
  }

  float x = clamp(bucket / 4.0, 0.0, 1.0);
  vec3 color = baseColor;

  vec3 iceWhite = vec3(0.91, 0.97, 1.0);
  float oldness = smoothstep(0.35, 1.0, x);
  color = mix(color, iceWhite, oldness * 0.20);

  float youngness = 1.0 - smoothstep(0.15, 0.55, x);
  color *= mix(vec3(0.82, 0.88, 0.94), vec3(1.0), 1.0 - youngness);
  color *= mix(vec3(1.0), vec3(0.86, 0.97, 1.14), oldness * 0.30);
  color = mix(color, vec3(0.82, 0.91, 0.97), youngness * 0.08);

  float tonal = mix(0.88, 1.08, smoothstep(0.0, 1.0, x));
  color *= tonal;
  color = pow(clamp(color, 0.0, 1.0), vec3(0.90));

  float alpha = opacity * mix(0.72, 0.96, smoothstep(0.0, 0.45, x));
  fragColor = vec4(clamp(color, 0.0, 1.0), alpha);
`;

function toGlslFloat(value: number): string {
  return Number.isInteger(value) ? `${value.toFixed(1)}` : `${value}`;
}

function hexToRgb(color: string): [number, number, number] | null {
  const normalized = color.trim();
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized);

  if (!match) {
    return null;
  }

  const [, rHex, gHex, bHex] = match;
  const r = Number.parseInt(rHex, 16) / 255;
  const g = Number.parseInt(gHex, 16) / 255;
  const b = Number.parseInt(bHex, 16) / 255;
  return [r, g, b];
}

function sampleShaderColormap(colormap: string[]): string[] {
  if (colormap.length <= MAX_SHADER_COLOR_STOPS) {
    return colormap;
  }

  return Array.from({ length: MAX_SHADER_COLOR_STOPS }, (_, index) => {
    const position = index / (MAX_SHADER_COLOR_STOPS - 1);
    const colorIndex = Math.round(position * (colormap.length - 1));
    return colormap[colorIndex];
  });
}

function buildCustomFragFromColormap(colormap: string[], clim: [number, number]): string {
  const [climMin, climMax] = clim;
  const parsedColors = sampleShaderColormap(colormap)
    .map(hexToRgb)
    .filter((value): value is [number, number, number] => value !== null);

  if (parsedColors.length === 0) {
    return ICE_AGE_CUSTOM_FRAG;
  }

  const shaderColors =
    parsedColors.length === 1 ? [parsedColors[0], parsedColors[0]] : parsedColors;
  const colorDefinitions = shaderColors
    .map(
      ([r, g, b], index) =>
        `  vec3 c${index} = vec3(${toGlslFloat(r)}, ${toGlslFloat(g)}, ${toGlslFloat(b)});`
    )
    .join('\n');

  const segmentCount = shaderColors.length - 1;
  const interpolationRules = Array.from({ length: segmentCount }, (_, index) => {
    const start = index / segmentCount;
    const end = (index + 1) / segmentCount;
    const prefix = index === 0 ? 'if' : 'else if';

    return `  ${prefix} (x <= ${toGlslFloat(end)}) {
    float t = smoothstep(${toGlslFloat(start)}, ${toGlslFloat(end)}, x);
    color = mix(c${index}, c${index + 1}, t);
  }`;
  }).join(' ');

  return `
  float age = age_of_sea_ice;

  if (age >= 20.5 || age <= 0.0 || age != age) {
    discard;
  }

  float x = clamp((age - ${toGlslFloat(climMin)}) / (${toGlslFloat(climMax)} - ${toGlslFloat(climMin)}), 0.0, 1.0);

${colorDefinitions}

  vec3 color = c0;
${interpolationRules} else {
    color = c${segmentCount};
  }

  float alpha = opacity * mix(0.72, 0.96, smoothstep(0.0, 0.45, x));
  fragColor = vec4(clamp(color, 0.0, 1.0), alpha);
`;
}

function normalizeMapStyle(value: string | null): MapStyleName {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_MAP_STYLE;
  }

  if (normalized in MAP_STYLE_URLS) {
    return normalized as MapStyleName;
  }

  return DEFAULT_MAP_STYLE;
}

type MapPageProps = {
  hasQuestStarted: boolean;
  yearIndex: number;
  timelineVisible: boolean;
  onToggleTimeline: () => void;
  onChangeYear: (index: number) => void;
  onStartOrResume: () => void;
};

export function MapPage({
  hasQuestStarted,
  yearIndex,
  timelineVisible,
  onToggleTimeline,
  onChangeYear,
  onStartOrResume
}: MapPageProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const zarrLayerRef = useRef<ZarrLayer | null>(null);
  const yearIndexRef = useRef(yearIndex);
  const startButtonTimerRef = useRef<number | null>(null);
  const zarrLoadRequestRef = useRef(0);
  const [isMapReady, setIsMapReady] = useState(false);
  const [isZarrLoading, setIsZarrLoading] = useState(false);
  const [isStartButtonPressing, setIsStartButtonPressing] = useState(false);
  const [queryColormapParam, setQueryColormapParam] = useState<string | null>(null);
  const [queryClimParam, setQueryClimParam] = useState<string | null>(null);
  const [datasetMode, setDatasetMode] = useState<DatasetMode>('normal');
  const [mapStyleName, setMapStyleName] = useState<MapStyleName>(DEFAULT_MAP_STYLE);
  const [queryParamsInitialized, setQueryParamsInitialized] = useState(false);

  const activeDatasetConfig = DATASET_CONFIG[datasetMode];
  const layerSource = activeDatasetConfig.sourceUrl;
  const mapStyleUrl = MAP_STYLE_URLS[mapStyleName];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Query params are browser-only; we intentionally initialize local state once after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryColormapParam(params.get('colormap'));
    setQueryClimParam(params.get('clim'));
    setDatasetMode(normalizeDatasetMode(params.get('dataset')));
    setMapStyleName(normalizeMapStyle(params.get('style')));
    setQueryParamsInitialized(true);
  }, []);

  useEffect(() => {
    if (!queryParamsInitialized) {
      return;
    }

    onChangeYear(0);
  }, [datasetMode, onChangeYear, queryParamsInitialized]);

  useEffect(() => {
    if (!queryParamsInitialized) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.set('dataset', datasetMode);
    params.set('style', mapStyleName);

    const queryString = params.toString();
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }, [datasetMode, mapStyleName, queryParamsInitialized]);

  const queryColormapName = useMemo(() => {
    const value = queryColormapParam?.trim();
    if (!value) {
      return null;
    }

    return COLORMAP_NAME_LOOKUP.get(value.toLowerCase()) ?? null;
  }, [queryColormapParam]);

  const layerColormap = useMemo(() => {
    if (!queryColormapName) {
      return ICE_COLORMAP;
    }

    try {
      return colormapBuilder(queryColormapName, 'hex', QUERY_COLORMAP_STEPS) as string[];
    } catch (error) {
      console.warn(
        `[MapPage] Unable to build colormap from query param: ${queryColormapName}. Falling back to default.`,
        error
      );
      return ICE_COLORMAP;
    }
  }, [queryColormapName]);

  const layerClim = useMemo<[number, number]>(() => {
    const defaultClim = activeDatasetConfig.defaultClim;
    const value = queryClimParam?.trim();
    if (!value) {
      return defaultClim;
    }

    const [startRaw, endRaw] = value.split(',');
    const start = Number.parseFloat(startRaw ?? '');
    const end = Number.parseFloat(endRaw ?? '');

    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      console.warn(`[MapPage] Invalid clim query param: ${value}. Falling back to default 0,5.`);
      return defaultClim;
    }

    return [start, end];
  }, [activeDatasetConfig.defaultClim, queryClimParam]);

  const legendColormap = useMemo(() => {
    if (layerColormap.length <= LEGEND_BINS) {
      return layerColormap;
    }

    return Array.from({ length: LEGEND_BINS }, (_, index) => {
      const position = index / (LEGEND_BINS - 1);
      const colorIndex = Math.round(position * (layerColormap.length - 1));
      return layerColormap[colorIndex];
    });
  }, [layerColormap]);

  const legendLabels = useMemo(() => {
    const [min, max] = layerClim;
    const binWidth = (max - min) / LEGEND_BINS;

    const format = (value: number) => {
      if (Number.isInteger(value)) {
        return `${value}`;
      }
      return value
        .toFixed(2)
        .replace(/\.0+$/, '')
        .replace(/(\.\d*[1-9])0+$/, '$1');
    };

    return Array.from({ length: LEGEND_BINS }, (_, index) => {
      const start = min + binWidth * index;
      const end = min + binWidth * (index + 1);

      if (index === LEGEND_BINS - 1) {
        return `${format(start)}+`;
      }

      return `${format(start)}-${format(end)}`;
    });
  }, [layerClim]);

  const layerCustomFrag = useMemo(
    () => buildCustomFragFromColormap(layerColormap, layerClim),
    [layerClim, layerColormap]
  );

  useEffect(() => {
    return () => {
      if (startButtonTimerRef.current) {
        window.clearTimeout(startButtonTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    yearIndexRef.current = yearIndex;
  }, [yearIndex]);

  function beginZarrLoad(requestMap: maplibregl.Map): number {
    const requestId = zarrLoadRequestRef.current + 1;
    zarrLoadRequestRef.current = requestId;
    setIsZarrLoading(true);

    requestMap.once('idle', () => {
      if (zarrLoadRequestRef.current === requestId) {
        setIsZarrLoading(false);
      }
    });

    return requestId;
  }

  function buildLayerSelector(mode: DatasetMode, selectedIndex: number): Selector {
    if (mode === 'climatology') {
      return { month: { selected: selectedIndex, type: 'index' } };
    }

    if (mode === 'yearly') {
      return { time: { selected: selectedIndex * 12 + 3, type: 'index' } };
    }

    return { time: { selected: selectedIndex, type: 'index' } };
  }

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    if (!queryParamsInitialized) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: [-90, 73],
      zoom: 1.75,
      pitch: 10,
      bearing: -8,
      attributionControl: {
        customAttribution: ''
      }
      // attributionControl: false
    });

    map.on('load', () => {
      map.setProjection({ type: 'globe' });
      addOceanAndSeaLabels(map);
      setIsMapReady(true);
    });

    mapRef.current = map;

    return () => {
      if (map.getLayer(ZARR_LAYER_ID)) {
        map.removeLayer(ZARR_LAYER_ID);
      }
      map.remove();
      mapRef.current = null;
      zarrLayerRef.current = null;
      zarrLoadRequestRef.current += 1;
      setIsZarrLoading(false);
      setIsMapReady(false);
    };
  }, [mapStyleUrl, queryParamsInitialized]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) {
      return;
    }

    if (map.getLayer(ZARR_LAYER_ID)) {
      map.removeLayer(ZARR_LAYER_ID);
    }
    zarrLayerRef.current = null;

    const selector = buildLayerSelector(datasetMode, yearIndexRef.current);
    beginZarrLoad(map);
    const zarrLayer = new ZarrLayer({
      id: ZARR_LAYER_ID,
      source: layerSource,
      variable: 'age_of_sea_ice',
      clim: layerClim,
      colormap: ICE_COLORMAP,
      zarrVersion: 3,
      bounds: [-4518421.5, -4518421.5, 4518421.5, 4518421.5],
      proj4: '+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +a=6371228 +b=6371228 +units=m +no_defs',
      selector,
      customFrag: layerCustomFrag
    });

    zarrLayerRef.current = zarrLayer;
    map.addLayer(zarrLayer);
    bringOceanAndSeaLabelsToFront(map);
  }, [datasetMode, isMapReady, layerClim, layerCustomFrag, layerSource]);

  useEffect(() => {
    const map = mapRef.current;
    const zarrLayer = zarrLayerRef.current;
    if (!map || !zarrLayer) {
      return;
    }

    const requestId = beginZarrLoad(map);
    const selector = buildLayerSelector(datasetMode, yearIndex);

    void zarrLayer.setSelector(selector).catch(error => {
      if (zarrLoadRequestRef.current === requestId) {
        setIsZarrLoading(false);
      }
      console.error('[MapPage] Failed to update zarr selector.', error);
    });
  }, [yearIndex, datasetMode]);

  function handleStartOrResumeClick() {
    if (startButtonTimerRef.current) {
      window.clearTimeout(startButtonTimerRef.current);
    }

    setIsStartButtonPressing(true);
    startButtonTimerRef.current = window.setTimeout(() => {
      onStartOrResume();
      setIsStartButtonPressing(false);
    }, 140);
  }

  return (
    <section className="font-test-sohne relative z-10 h-dvh w-dvw">
      <div className="absolute inset-0">
        <div ref={mapContainerRef} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(255,255,255,0.1),rgba(0,0,0,0.55)_75%)]" />
      </div>

      <MapYearLegend
        yearIndex={yearIndex}
        datasetMode={datasetMode}
        legendColormap={legendColormap}
        legendLabels={legendLabels}
        legendUnitLabel={activeDatasetConfig.legendUnitLabel}
      />
      <TimeSlider
        yearIndex={yearIndex}
        datasetMode={datasetMode}
        timelineVisible={timelineVisible}
        onToggleTimeline={onToggleTimeline}
        onChangeYear={onChangeYear}
        onChangeDatasetMode={setDatasetMode}
        isZarrLoading={isZarrLoading}
      />
    </section>
  );
}
