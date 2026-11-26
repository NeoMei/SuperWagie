import { createContext, useContext } from 'react';

export const PlatformServicesContext = createContext(false);
export const usePlatformServices = () => useContext(PlatformServicesContext);
