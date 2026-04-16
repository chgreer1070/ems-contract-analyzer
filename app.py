import json
import os
from flask import Flask, render_template, request, jsonify, make_response
from analyzer import ContractAnalyzer

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

analyzer = ContractAnalyzer()

ALLOWED_EXTENSIONS = {"txt", "pdf", "docx"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route("/")
def index():
    return render_template("index.html")


def _extract_request_text(file_key="contract"):
    """Extract contract text from the current request (file upload or text field)."""
    if file_key in request.files:
        file = request.files[file_key]
        if file.filename == "":
            return None, (jsonify({"error": "No file selected"}), 400)
        if not allowed_file(file.filename):
            return None, (jsonify({"error": "File type not allowed. Use .txt, .pdf, or .docx"}), 400)
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
        file.save(filepath)
        text = analyzer.extract_text(filepath)
        os.remove(filepath)
        return text, None
    elif request.is_json and request.json.get("text"):
        return request.json["text"], None
    elif request.form.get("text"):
        return request.form["text"], None
    return None, (jsonify({"error": "No contract text or file provided"}), 400)


@app.route("/analyze", methods=["POST"])
def analyze():
    text, err = _extract_request_text()
    if err:
        return err
    if not text or not text.strip():
        return jsonify({"error": "Could not extract text from the provided input"}), 400
    result = analyzer.analyze(text)
    return jsonify(result)


@app.route("/export", methods=["POST"])
def export():
    text, err = _extract_request_text()
    if err:
        return err
    if not text or not text.strip():
        return jsonify({"error": "Could not extract text from the provided input"}), 400

    fmt = (request.form.get("format") or request.args.get("format") or "pdf").lower()
    if fmt not in ("pdf", "html", "json"):
        return jsonify({"error": "Invalid format. Use pdf, html, or json."}), 400

    result = analyzer.analyze(text)

    if fmt == "json":
        resp = make_response(json.dumps(result, indent=2))
        resp.headers["Content-Type"] = "application/json"
        resp.headers["Content-Disposition"] = "attachment; filename=contract_report.json"
        return resp
    elif fmt == "html":
        html = render_template("report.html", data=result)
        resp = make_response(html)
        resp.headers["Content-Type"] = "text/html"
        resp.headers["Content-Disposition"] = "attachment; filename=contract_report.html"
        return resp
    else:  # pdf
        pdf_bytes = analyzer.build_pdf_report(result)
        resp = make_response(pdf_bytes)
        resp.headers["Content-Type"] = "application/pdf"
        resp.headers["Content-Disposition"] = "attachment; filename=contract_report.pdf"
        return resp


@app.route("/compare", methods=["POST"])
def compare():
    text_a, err_a = _extract_request_text("contract_a")
    if err_a:
        # Try text fields
        text_a = request.form.get("text_a")
    text_b_file, err_b = _extract_request_text("contract_b")
    if err_b:
        text_b_file = None
    text_b = text_b_file or request.form.get("text_b")

    if not text_a or not text_a.strip():
        return jsonify({"error": "Missing first contract (text_a or contract_a file)"}), 400
    if not text_b or not text_b.strip():
        return jsonify({"error": "Missing second contract (text_b or contract_b file)"}), 400

    result = analyzer.compare_contracts(text_a, text_b)
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
