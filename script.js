// Set tracking cookie if not exists
if (!document.cookie.split(';').some(c => c.trim().startsWith('tracking_id='))) {
  const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  document.cookie = `tracking_id=${id}; path=/; max-age=${60*60*24*30}`; // 30 days
}

const socket = io();
let lastElement = null;
let lastMousePosition = { x: 0, y: 0 };
let currentPage = window.location.pathname;
let lastActionTime = Date.now();

// Track initial page view
socket.emit('track_event', {
  type: 'page_view',
  data: {
    referrer: document.referrer,
    url: window.location.href,
    elements: getVisibleElements(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  },
  page: currentPage
});

// Track mouse movement with element detection
document.addEventListener('mousemove', (e) => {
  const now = Date.now();
  const element = document.elementFromPoint(e.clientX, e.clientY);
  const elementInfo = element ? getElementInfo(element) : null;

  // Only send if element changed or 10 seconds passed
  if (elementInfo && (now - lastActionTime > 10000 || 
      !lastElement || 
      elementInfo.id !== lastElement.id || 
      elementInfo.tag !== lastElement.tag)) {
    lastElement = elementInfo;
    lastActionTime = now;
    
    socket.emit('track_event', {
      type: 'mouse_move',
      data: {
        x: e.clientX,
        y: e.clientY,
        element: elementInfo,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      },
      page: currentPage
    });
  }
});

// Track clicks
document.addEventListener('click', (e) => {
  const element = e.target;
  socket.emit('track_event', {
    type: 'click',
    data: {
      element: getElementInfo(element),
      position: { x: e.clientX, y: e.clientY }
    },
    page: currentPage
  });
});

// Get detailed element information
function getElementInfo(element) {
  const text = element.textContent.trim();
  return {
    tag: element.tagName,
    id: element.id || null,
    class: element.className || null,
    text: text.length > 50 ? text.substring(0, 47) + '...' : text || null,
    position: element.getBoundingClientRect()
  };
}

// Track page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    socket.emit('track_event', { 
      type: 'tab_hidden',
      page: currentPage
    });
  } else {
    socket.emit('track_event', { 
      type: 'tab_visible',
      page: currentPage
    });
  }
});

// Track beforeunload (when user leaves)
window.addEventListener('beforeunload', () => {
  socket.emit('track_event', { 
    type: 'page_leave',
    page: currentPage
  });
});


// Track page changes for SPA (if applicable)
window.addEventListener('popstate', () => {
  if (window.location.pathname !== currentPage) {
    currentPage = window.location.pathname;
    socket.emit('track_event', {
      type: 'page_view',
      data: {
        url: window.location.href,
        elements: getVisibleElements(),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      },
      page: currentPage
    });
  }
});

// Get all visible elements for screen simulation
function getVisibleElements() {
  const elements = [];
  const allElements = document.querySelectorAll('*');
  
  for (const el of allElements) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && 
        rect.top < window.innerHeight && 
        rect.left < window.innerWidth) {
      elements.push({
        tag: el.tagName,
        id: el.id || null,
        class: el.className || null,
        position: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        }
      });
    }
  }
  return elements;
}