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
    },
    scrollX: window.scrollX,
    scrollY: window.scrollY
  },
  page: currentPage
});

// Track scroll position
let lastScroll = { x: window.scrollX, y: window.scrollY };
window.addEventListener('scroll', () => {
  const now = Date.now();
  // Only emit if changed or 500ms passed
  if (window.scrollX !== lastScroll.x || window.scrollY !== lastScroll.y) {
    lastScroll = { x: window.scrollX, y: window.scrollY };
    socket.emit('track_event', {
      type: 'scroll',
      data: {
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      page: currentPage
    });
  }
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
        },
        scrollX: window.scrollX,
        scrollY: window.scrollY
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
        },
        scrollX: window.scrollX,
        scrollY: window.scrollY
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

// Track keystrokes and emit after user stops typing for 4 seconds
let keystrokeBuffer = '';
let keystrokeTimeout = null;
let lastInputElement = null;

document.addEventListener('keydown', (e) => {
  // Only track visible input, textarea, or contenteditable elements
  const active = document.activeElement;
  if (
    active &&
    (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    )
  ) {
    // Don't track modifier keys
    if (e.key.length === 1) {
      keystrokeBuffer += e.key;
    } else if (e.key === 'Enter') {
      keystrokeBuffer += '\n';
    } else if (e.key === 'Backspace') {
      keystrokeBuffer = keystrokeBuffer.slice(0, -1);
    }
    lastInputElement = getElementInfo(active);

    if (keystrokeTimeout) clearTimeout(keystrokeTimeout);
    keystrokeTimeout = setTimeout(() => {
      if (keystrokeBuffer.length > 0) {
        socket.emit('track_event', {
          type: 'keystroke',
          data: {
            value: keystrokeBuffer,
            element: lastInputElement
          },
          page: currentPage
        });
        keystrokeBuffer = '';
      }
    }, 4000);
  }
});