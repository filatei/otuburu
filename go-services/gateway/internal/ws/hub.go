// Package ws implements the WebSocket hub — subscribe/fan-out pattern.
// Each authenticated client gets a connection; the hub broadcasts
// tick and state messages from the engine to all subscribers.
package ws

import (
	"log/slog"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // TODO: restrict in production
}

// Client represents a single connected WebSocket client.
type Client struct {
	conn      *websocket.Conn
	send      chan []byte
	hub       *Hub
	accountID string // the account whose state this client wants; set from ?account_id=
}

// Hub maintains the set of active clients and broadcasts messages.
type Hub struct {
	mu         sync.RWMutex
	clients    map[*Client]struct{}
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

// Run is the hub's main loop — must be called in a goroutine.
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = struct{}{}
			h.mu.Unlock()
			slog.Info("ws client connected", "remote", c.conn.RemoteAddr(), "account_id", c.accountID)

		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
			slog.Info("ws client disconnected", "remote", c.conn.RemoteAddr())

		case msg := <-h.broadcast:
			h.mu.RLock()
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					// slow client — drop
				}
			}
			h.mu.RUnlock()
		}
	}
}

// Broadcast sends a message to ALL connected clients (used for tick fan-out).
func (h *Hub) Broadcast(msg []byte) {
	h.broadcast <- msg
}

// AccountIDs returns the distinct set of non-empty account IDs currently connected.
func (h *Hub) AccountIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := make(map[string]struct{})
	for c := range h.clients {
		if c.accountID != "" {
			seen[c.accountID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}

// BroadcastToAccount sends msg only to clients whose accountID matches.
func (h *Hub) BroadcastToAccount(accountID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.accountID == accountID {
			select {
			case c.send <- msg:
			default:
				// slow client — drop
			}
		}
	}
}

// HandleUpgrade upgrades an HTTP connection to WebSocket and registers the client.
// The caller should pass ?account_id=<uuid> in the query string so state messages
// are routed to the correct account.
func (h *Hub) HandleUpgrade(c *gin.Context) {
	accountID := c.Query("account_id") // may be empty for unauthenticated / tick-only clients

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		slog.Error("ws upgrade failed", "err", err)
		return
	}
	client := &Client{conn: conn, send: make(chan []byte, 64), hub: h, accountID: accountID}
	h.register <- client

	go client.writePump()
	go client.readPump()
}

func (c *Client) writePump() {
	defer func() {
		c.conn.Close()
	}()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		// Clients are read-only in Phase 1 (orders go via REST)
	}
}
