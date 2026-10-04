/*
 * nikcli gadget on an ESP32: Wi-Fi, pairing, then the portable client.
 *
 * NOT BUILT. This file was written against ESP-IDF's documented APIs without an
 * ESP-IDF toolchain to compile it, so treat it as a starting point: the
 * protocol code it calls (`../../src`) is built and tested on a host, this glue
 * is not. Build it with `idf.py build`; if the compiler disagrees with this
 * file, the compiler is right.
 *
 * Flow: join Wi-Fi; if NVS holds no token, pair with CONFIG_NIKCLI_PAIR_CODE
 * (waiting for the button when the bridge asks); then serve the feed forever.
 * Commands: device.health and, with an LED, led.set. A button press is `ok`.
 * A board with a panel receives 1-bit frames in `display_draw`.
 */
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nikcli_gadget.h"
#include "ng_json.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "nikcli";
#define WIFI_UP BIT0
static EventGroupHandle_t wifi_events;
static ng_config cfg;
static volatile int stop_flag = 0;
static char fingerprint[24];

/* ------------------------------------------------------------ platform glue */

static uint64_t now_ms(void) { return (uint64_t)(esp_timer_get_time() / 1000); }
static void sleep_ms(unsigned ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }
static void log_line(void *user, const char *line) {
    (void)user;
    ESP_LOGI(TAG, "%s", line);
}

static void led_set(bool on) {
#if CONFIG_NIKCLI_LED_GPIO >= 0
    gpio_set_level(CONFIG_NIKCLI_LED_GPIO, CONFIG_NIKCLI_LED_ACTIVE_LOW ? !on : on);
#else
    (void)on;
#endif
}

/* A board with a panel overrides this (declared weak so this file links alone). */
__attribute__((weak)) void display_draw(int width, int height, const uint8_t *packed, size_t len) {
    ESP_LOGI(TAG, "frame %dx%d, %u bytes (no panel driver linked)", width, height, (unsigned)len);
}

static void on_bitmap(void *user, int w, int h, const uint8_t *packed, size_t len) {
    (void)user;
    display_draw(w, h, packed, len);
}

static int poll_button(void *user, char *key, size_t key_len) {
    (void)user;
#if CONFIG_NIKCLI_BUTTON_GPIO >= 0
    static int last = 1;
    static uint64_t changed = 0;
    int level = gpio_get_level(CONFIG_NIKCLI_BUTTON_GPIO);
    uint64_t t = now_ms();
    if (level != last && t - changed > 50) {
        last = level;
        changed = t;
        if (level == 0) {
            snprintf(key, key_len, "ok");
            return 1;
        }
    }
#else
    (void)key;
    (void)key_len;
#endif
    return 0;
}

/* ------------------------------------------------------------------ commands */

static int cmd_health(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)args;
    (void)deadline;
    wifi_ap_record_t ap = { 0 };
    esp_wifi_sta_get_ap_info(&ap);
    snprintf(out, out_len,
             "{\"uptimeSec\":%lld,\"load\":[0,0,0],\"memory\":{\"totalBytes\":%u,\"freeBytes\":%u},\"rssi\":%d,\"time\":0}",
             (long long)(esp_timer_get_time() / 1000000), (unsigned)heap_caps_get_total_size(MALLOC_CAP_DEFAULT),
             (unsigned)esp_get_free_heap_size(),
             ap.rssi);
    *exit_code = 0;
    return 0;
}

static int cmd_led(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)deadline;
    ng_jtok t[8];
    int n = ng_json_parse(args, strlen(args), t, 8);
    int on = n > 0 ? ng_json_get(args, t, 0, "on") : -1;
    if (on < 0) {
        snprintf(out, out_len, "led.set needs {\"on\": boolean}");
        *exit_code = 2;
        return 1;
    }
    bool value = ng_json_true(args, &t[on]);
    led_set(value);
    snprintf(out, out_len, "led %s", value ? "on" : "off");
    *exit_code = 0;
    return 0;
}

static const ng_command COMMANDS[] = {
    { "device.health", "Uptime, free heap and Wi-Fi signal of the board.", "{\"type\":\"object\",\"properties\":{}}", 5000, cmd_health },
#if CONFIG_NIKCLI_LED_GPIO >= 0
    { "led.set", "Turn the status LED on or off.", "{\"type\":\"object\",\"properties\":{\"on\":{\"type\":\"boolean\"}},\"required\":[\"on\"]}", 5000, cmd_led },
#endif
};

static const char *const BUTTONS[] = { "ok" };

/* --------------------------------------------------------------------- state */

static bool load_pairing(void) {
    nvs_handle_t nvs;
    if (nvs_open("nikcli", NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t id_len = sizeof cfg.id, token_len = sizeof cfg.token;
    bool ok = nvs_get_str(nvs, "id", cfg.id, &id_len) == ESP_OK && nvs_get_str(nvs, "token", cfg.token, &token_len) == ESP_OK;
    nvs_close(nvs);
    return ok;
}

static void save_pairing(void) {
    nvs_handle_t nvs;
    if (nvs_open("nikcli", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_set_str(nvs, "id", cfg.id);
    nvs_set_str(nvs, "token", cfg.token);
    nvs_commit(nvs);
    nvs_close(nvs);
}

static void forget_pairing(void) {
    nvs_handle_t nvs;
    if (nvs_open("nikcli", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_erase_all(nvs);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
    cfg.id[0] = cfg.token[0] = '\0';
}

/* ---------------------------------------------------------------------- wifi */

static void wifi_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events, WIFI_UP);
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(wifi_events, WIFI_UP);
    }
}

static void wifi_start(void) {
    wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_handler, NULL));
    wifi_config_t wifi = { 0 };
    strncpy((char *)wifi.sta.ssid, CONFIG_NIKCLI_WIFI_SSID, sizeof wifi.sta.ssid - 1);
    strncpy((char *)wifi.sta.password, CONFIG_NIKCLI_WIFI_PASSWORD, sizeof wifi.sta.password - 1);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
}

/* ---------------------------------------------------------------------- task */

static void gadget_task(void *arg) {
    (void)arg;
    for (;;) {
        xEventGroupWaitBits(wifi_events, WIFI_UP, pdFALSE, pdTRUE, portMAX_DELAY);
        if (!cfg.token[0]) {
            bool confirm = false;
            if (strlen(CONFIG_NIKCLI_PAIR_CODE) == 0) {
                ESP_LOGE(TAG, "not paired and no pairing code: run /gadget pair, put the code in menuconfig, flash");
                vTaskDelay(pdMS_TO_TICKS(30000));
                continue;
            }
            int r = ng_pair(&cfg, CONFIG_NIKCLI_PAIR_CODE, &confirm);
            if (r != NG_OK) {
                ESP_LOGE(TAG, "pairing failed: %s", cfg.last_error);
                vTaskDelay(pdMS_TO_TICKS(10000));
                continue;
            }
            if (confirm) {
                ESP_LOGI(TAG, "press the button to confirm pairing");
                char key[8];
                while (poll_button(NULL, key, sizeof key) != 1) vTaskDelay(pdMS_TO_TICKS(20));
                if (ng_confirm(&cfg) != NG_OK) {
                    ESP_LOGE(TAG, "confirm failed: %s", cfg.last_error);
                    forget_pairing();
                    continue;
                }
            }
            save_pairing();
        }
        int r = ng_run(&cfg, &stop_flag);
        if (r == NG_ERR_REVOKED || r == NG_ERR_NOT_PAIRED) forget_pairing();
    }
}

void app_main(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
#if CONFIG_NIKCLI_LED_GPIO >= 0
    gpio_reset_pin(CONFIG_NIKCLI_LED_GPIO);
    gpio_set_direction(CONFIG_NIKCLI_LED_GPIO, GPIO_MODE_OUTPUT);
    led_set(false);
#endif
#if CONFIG_NIKCLI_BUTTON_GPIO >= 0
    gpio_config_t io = { .pin_bit_mask = 1ULL << CONFIG_NIKCLI_BUTTON_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
    gpio_config(&io);
#endif
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(fingerprint, sizeof fingerprint, "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    memset(&cfg, 0, sizeof cfg);
    cfg.server = CONFIG_NIKCLI_SERVER;
    cfg.name = CONFIG_NIKCLI_NAME;
    cfg.fingerprint = fingerprint;
    cfg.os = "esp-idf";
    cfg.arch = CONFIG_IDF_TARGET;
    cfg.commands = COMMANDS;
    cfg.command_count = sizeof COMMANDS / sizeof COMMANDS[0];
#if CONFIG_NIKCLI_BUTTON_GPIO >= 0
    cfg.buttons = BUTTONS;
    cfg.button_count = 1;
#endif
    cfg.on_bitmap = on_bitmap;
    cfg.poll_button = poll_button;
    cfg.log = log_line;
    cfg.now_ms = now_ms;
    cfg.sleep_ms = sleep_ms;
    cfg.out_cap = 512;
    cfg.frame_cap = 8192;
    (void)BUTTONS;

    load_pairing();
    wifi_start();
    xTaskCreate(gadget_task, "nikcli_gadget", 8192, NULL, 5, NULL);
}
