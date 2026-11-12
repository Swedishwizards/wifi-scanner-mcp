// WifiScanHelper — tiny macOS helper for wifi-scanner-mcp.
//
// macOS only reveals Wi-Fi names (SSIDs) and BSSIDs to apps that the user has allowed
// to use Location Services. A command-line process cannot ask for that permission,
// so the MCP server launches this background app instead. It:
//   1. asks for Location permission the first time (one system dialog),
//   2. scans with CoreWLAN,
//   3. writes the result as JSON to the path given as the first argument, and quits.
// It never connects to anything, stores nothing and sends nothing over the network.

import AppKit
import CoreLocation
import CoreWLAN
import Foundation

let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : (NSTemporaryDirectory() as NSString).appendingPathComponent("wifi-scanner.json")

func finish(_ obj: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []) {
        let tmp = outPath + ".tmp"
        if (try? data.write(to: URL(fileURLWithPath: tmp))) != nil {
            try? FileManager.default.removeItem(atPath: outPath)
            try? FileManager.default.moveItem(atPath: tmp, toPath: outPath)
        }
    }
    exit(0)
}

func securityName(_ n: CWNetwork) -> String {
    if n.supportsSecurity(.wpa3Enterprise) || n.supportsSecurity(.wpa2Enterprise)
        || n.supportsSecurity(.wpaEnterprise) || n.supportsSecurity(.enterprise)
        || n.supportsSecurity(.wpaEnterpriseMixed) { return "Enterprise" }
    let wpa3 = n.supportsSecurity(.wpa3Personal) || n.supportsSecurity(.wpa3Transition)
    let wpa2 = n.supportsSecurity(.wpa2Personal) || n.supportsSecurity(.wpaPersonalMixed)
        || n.supportsSecurity(.personal) || n.supportsSecurity(.wpa3Transition)
    if wpa3 && wpa2 { return "WPA2/WPA3 Personal" }
    if wpa3 { return "WPA3 Personal" }
    if wpa2 { return "WPA2 Personal" }
    if n.supportsSecurity(.wpaPersonal) { return "WPA Personal" }
    if n.supportsSecurity(.dynamicWEP) || n.supportsSecurity(.WEP) { return "WEP" }
    if n.supportsSecurity(.OWE) || n.supportsSecurity(.oweTransition) { return "OWE" }
    if n.supportsSecurity(.none) { return "Open" }
    return "Unknown"
}

func securityName(_ s: CWSecurity) -> String {
    switch s {
    case .none: return "Open"
    case .WEP, .dynamicWEP: return "WEP"
    case .wpaPersonal: return "WPA Personal"
    case .wpaPersonalMixed, .wpa2Personal, .personal: return "WPA2 Personal"
    case .wpa3Personal: return "WPA3 Personal"
    case .wpa3Transition: return "WPA2/WPA3 Personal"
    case .wpaEnterprise, .wpaEnterpriseMixed, .wpa2Enterprise, .enterprise, .wpa3Enterprise: return "Enterprise"
    case .OWE, .oweTransition: return "OWE"
    default: return "Unknown"
    }
}

func bandName(_ c: CWChannel?) -> Any {
    guard let c = c else { return NSNull() }
    switch c.channelBand {
    case .band2GHz: return "2.4 GHz"
    case .band5GHz: return "5 GHz"
    case .band6GHz: return "6 GHz"
    default: return NSNull()
    }
}

func widthMHz(_ c: CWChannel?) -> Any {
    guard let c = c else { return NSNull() }
    switch c.channelWidth {
    case .width20MHz: return 20
    case .width40MHz: return 40
    case .width80MHz: return 80
    case .width160MHz: return 160
    default: return NSNull()
    }
}

func phyName(_ m: CWPHYMode) -> Any {
    switch m {
    case .mode11a: return "802.11a"
    case .mode11b: return "802.11b"
    case .mode11g: return "802.11g"
    case .mode11n: return "802.11n"
    case .mode11ac: return "802.11ac"
    case .mode11ax: return "802.11ax"
    default: return NSNull()
    }
}

func orNull(_ v: Any?) -> Any { v ?? NSNull() }

func scan() -> Never {
    guard let iface = CWWiFiClient.shared().interface() else {
        finish(["error": "No Wi-Fi interface found.", "code": "no_adapter"])
    }
    if !iface.powerOn() {
        finish(["error": "Wi-Fi is turned off.", "code": "wifi_off", "interface": orNull(iface.interfaceName), "power": false])
    }

    var current: Any = NSNull()
    if let ssid = iface.ssid() {
        current = [
            "ssid": ssid,
            "bssid": orNull(iface.bssid()),
            "rssi": iface.rssiValue(),
            "noise": iface.noiseMeasurement(),
            "channel": orNull(iface.wlanChannel()?.channelNumber),
            "band": bandName(iface.wlanChannel()),
            "width": widthMHz(iface.wlanChannel()),
            "security": securityName(iface.security()),
            "phyMode": phyName(iface.activePHYMode()),
            "txRate": iface.transmitRate(),
        ] as [String: Any]
    }

    do {
        let found = try iface.scanForNetworks(withSSID: nil)
        var list: [[String: Any]] = []
        for n in found {
            list.append([
                "ssid": orNull(n.ssid),
                "bssid": orNull(n.bssid),
                "rssi": n.rssiValue,
                "noise": n.noiseMeasurement,
                "channel": orNull(n.wlanChannel?.channelNumber),
                "band": bandName(n.wlanChannel),
                "width": widthMHz(n.wlanChannel),
                "security": securityName(n),
            ])
        }
        finish([
            "interface": orNull(iface.interfaceName),
            "power": true,
            "current": current,
            "networks": list,
        ])
    } catch {
        finish(["error": "Scan failed: \(error.localizedDescription)", "code": "scan_failed"])
    }
}

final class Delegate: NSObject, CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .notDetermined:
            // Bring the helper forward so the permission dialog is visible.
            NSApp.activate(ignoringOtherApps: true)
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish(["error": "WifiScanHelper is not allowed to use Location Services, so macOS hides Wi-Fi names.",
                    "code": "permission_denied"])
        default:
            scan()
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let manager = CLLocationManager()
let delegate = Delegate()
manager.delegate = delegate
DispatchQueue.main.asyncAfter(deadline: .now() + 75) {
    finish(["error": "No answer to the Location permission request.", "code": "permission_timeout"])
}
app.run()
