import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { DataSourceMode } from "./data-client";

export const FORCE_REMOTE = process.env.NEXT_PUBLIC_FORCE_REMOTE === "true";

const MODE: DataSourceMode = FORCE_REMOTE ? "remote" : "local";

interface DataSourceContextValue {
  mode: DataSourceMode;
}

export const DataSourceContext = createContext<DataSourceContextValue>({ mode: MODE });

export function useDataSource() {
  return useContext(DataSourceContext);
}

export function DataSourceProvider({ children }: { children: ReactNode }) {
  return (
    <DataSourceContext.Provider value={{ mode: MODE }}>
      {children}
    </DataSourceContext.Provider>
  );
}
