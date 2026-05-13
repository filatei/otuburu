// Package rest proxies REST calls from clients to the Rust engine gRPC API.
package rest

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

var engineAddr = envOr("ENGINE_ADDR", "localhost:9090")

// RegisterRoutes wires REST proxy endpoints.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/symbols",   handleSymbols)
	rg.GET("/state",     handleState)
	rg.POST("/order",    handleOrder)
	rg.POST("/close",    handleClose)
	rg.POST("/binary",   handleBinary)
}

// TODO: replace HTTP stubs with gRPC calls to the Rust engine once protos are generated.

func handleSymbols(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"symbols": []string{
		"BOOM1000", "CRASH1000", "BOOM500",
		"frxEURUSD", "frxGBPUSD",
		"cryBTCUSD", "cryETHUSD",
	}})
}

func handleState(c *gin.Context) {
	// Stub: will call engine via gRPC
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "engine not connected", "engine": engineAddr})
}

func handleOrder(c *gin.Context) {
	var req map[string]interface{}
	_ = c.ShouldBindJSON(&req)
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "engine not connected"})
}

func handleClose(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "engine not connected"})
}

func handleBinary(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"error": "engine not connected"})
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
