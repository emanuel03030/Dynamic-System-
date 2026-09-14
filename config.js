/**
 * Configuração Global do Sistema
 * 
 * Define a URL da API para frontend e backend
 * Este arquivo deve ser carregado ANTES dos arquivos que usam a API
 */



(function() {
  // Detectar URL da API automaticamente
  function detectApiUrl() {
    // 1. Usar variável de ambiente se disponível (window.API_BASE_URL)
    if (typeof window !== 'undefined' && window.API_BASE_URL) {
      return String(window.API_BASE_URL).replace(/\/$/, '');
    }

    const protocol = String(window.location.protocol || '').toLowerCase();
    const hostname = String(window.location.hostname || '').toLowerCase();

    // 2. Quando aberto como arquivo local (file://), usar backend local padrao.
    if (protocol === 'file:' || !hostname) {
      return 'http://localhost:3000';

      
    }

    // 3. Em desenvolvimento local, tentar localhost:3001
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }

    // 4. Em produção, usar o mesmo domínio/porta
    const port = window.location.port ? ':' + window.location.port : '';
    
    // Se tem porta customizada no frontend, usar mesma porta
    if (window.location.port) {
      return protocol + '//' + hostname + port;
    }

    // Senão, assumir que a API está no mesmo domínio na porta padrão
    return protocol + '//' + hostname;

  }

  // Setar a URL da API global
  window.__DATA_API_BASE_URL = detectApiUrl();
  // Autenticação local: usa o mesmo servidor da aplicação (sem servidor centralizado)
  // Cada usuário tem seu próprio servidor local

  // Log para debug (remove em produção se desejar)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.log('[Config] API URL:', window.__DATA_API_BASE_URL);
  }
})();

// Configuração de variáveis globais
window.__CONFIG = {
  // URL da API (detectada automaticamente)
  API_BASE_URL: window.__DATA_API_BASE_URL
};

// Configuração de variáveis globais para autenticação  
window.__AUTH_CONFIG = {
  // URL do servidor de autenticação (pode ser o mesmo da API)
  AUTH_SERVER_URL: window.__DATA_API_BASE_URL,
};
