idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES nikcli_gadget esp_wifi esp_event esp_netif nvs_flash driver esp_timer esp_system
)
