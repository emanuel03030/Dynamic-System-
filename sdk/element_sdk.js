// Element SDK - Simulação básica
window.elementSdk = {
  init: function(config) {
    console.log('Element SDK initialized');
    // Simula configuração
    if (config.onConfigChange) {
      config.onConfigChange(config.defaultConfig);
    }
    return true;
  },
  setConfig: function(newConfig) {
    console.log('Config updated:', newConfig);
  }
};