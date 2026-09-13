"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { applyTheme, resolveSavedTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";
const ThemeContext = createContext<{ theme: Theme; resolvedTheme: Theme; setTheme: (theme: Theme) => void }>({theme:"dark",resolvedTheme:"dark",setTheme:()=>{}});
export function ThemeProvider({children}:{children:ReactNode}) {
  const [theme,setThemeState]=useState<Theme>("dark");
  useEffect(()=>{let initial:Theme="dark";try {initial=resolveSavedTheme(localStorage.getItem(THEME_STORAGE_KEY));}catch{} applyTheme(initial);setThemeState(initial);},[]);
  const setTheme=(next:Theme)=>{applyTheme(next);setThemeState(next);try{localStorage.setItem(THEME_STORAGE_KEY,next);}catch{}};
  return <ThemeContext.Provider value={{theme,resolvedTheme:theme,setTheme}}>{children}</ThemeContext.Provider>;
}
export function useTheme(){return useContext(ThemeContext);}
